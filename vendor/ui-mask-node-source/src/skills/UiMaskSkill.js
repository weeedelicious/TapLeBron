import { BaseNode } from '../node-editor/BaseNode.js';
import { UiMaskEditor } from '../ui/UiMaskEditor.js';
import { UiMaskExperiment } from '../ui/UiMaskExperiment.js';
import { UiMaskModelOutput } from './UiMaskModelOutput.js';
import { validateMaskDocument, sourceIdentity } from './UiMaskDocument.js';
import { localRequest, videoSourceUrl, videoSourceFile } from '../utils/LocalVideo.js';

const post=data=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
export class UiMaskSkill extends BaseNode {
  static nodeId='ui_mask';
  static nodeName='UI遮罩';
  constructor(id,x,y){
    super(id,'ui_mask',x,y);this.addInput('视频源','video');this.addOutput('遮罩视频','video');
    this.addParam('outputSource','工作方式','editor','select',[{value:'editor',label:'Mask遮罩AI/手动编辑'},{value:'model',label:'动态模型草稿'}]);
    this.addParam('outputCategory','当前输出','static','select',[{value:'static',label:'静态遮罩视频'},{value:'dynamic',label:'动态遮罩视频'}]);
    this.addParam('dynamicMode','动态覆盖','follow','select',[{value:'follow',label:'跟随覆盖'},{value:'trail',label:'拖尾覆盖'}]);
    this.addParam('detector','辅助识别','auto','select',[{value:'auto',label:'AI 辅助'},{value:'rules',label:'基础识别（轻量）'}]);
    this.addParam('temporalRecovery','跨帧恢复','off','select',[{value:'off',label:'标准'},{value:'guarded-v2',label:'保守试用 · 未验收'}]);
    this.width=340;this.previewHeight=280;this.maskTask=null;this.document=null;this.results=[];
    this.busy=false;this.activeJobId=null;this.message='连接视频后可直接手画，也可先辅助识别再修改';this.version=0;this.editVersion=0;
    this.modelMaskTask=null;this.modelOutput=new UiMaskModelOutput(this);
  }
  getHeight(){const ports=Math.max(this.inputs.length,this.outputs.length);return this.baseHeight+this.previewHeight+ports*28+28;}
  source(){return this.getInput('视频源');}
  outputMode(){return this.getParam('outputCategory')==='static'?'follow':this.getParam('dynamicMode');}
  show(message){this.message=message;this.refresh();}
  persist(){window.editor?._scheduleSave?.();}
  propagate(){this.executed=false;for(const edge of window.editor?.connections||[])if(edge.from.node===this)window.editor.resetDownstream(edge.to.node);window.editor?.onNodeChange?.(this);}
  setParam(key,value){
    if(key==='outputSource'&&!['editor','model'].includes(value))return;
    if(key==='temporalRecovery'&&!['off','guarded-v2'].includes(value))return;
    if(key==='dynamicMode'&&!['follow','trail'].includes(value))return;
    if(key==='outputCategory'&&!['static','dynamic'].includes(value))return;
    if(key==='detector'&&!['auto','rules'].includes(value))return;
    const changed=this.getParam(key)!==value;super.setParam(key,value);
    if(changed&&key==='outputSource'){this.editor?.close();this.modelOutput.editSession?.editor?.close();if(value==='editor')this.restore();}
    if(changed&&(key==='outputCategory'||(key==='dynamicMode'&&this.getParam('outputCategory')==='dynamic'))){
      this.results=[];if(this.maskTask){this.maskTask.exportId=null;this.maskTask.confirmedRevision=null;}
      this.show('覆盖方式已改变，请检查并确认生成黑色遮罩视频');
      const control=this.element?.querySelector(`[data-key="${key}"]`);if(control)control.value=value;
      if(key==='outputCategory')this.editor?.setCategory(value);
      this.persist();
    }
    if(changed&&key==='temporalRecovery'){this.results=[];if(this.maskTask){this.maskTask.exportId=null;this.maskTask.confirmedRevision=null;this.maskTask.needsReanalysis=true;}this.show('跨帧方式已改变，请重新辅助识别动态 UI');this.persist();}
    this.propagate();this.refresh();
  }
  requestedDetector(){
    const detector=this.getParam('detector')==='panel'?'auto':this.getParam('detector');
    if(detector==='rules')return 'rules';
    return this.getParam('outputCategory')==='dynamic'?'auto':'panel';
  }
  async openExperiment(preferredVersion=null){
    if(this.busy||this.modelOutput.state==='checking')return;
    try{
      await this.flushDocument();
      await this.modelOutput.editSession?.flushDocument();
      if(this.disposed)return;
      this.editor?.close();this.experiment?.close();
      this.experiment=new UiMaskExperiment(this,{preferredVersion});
    }catch(error){this.show(`无法打开检测草稿：${error.message}`);}
  }
  execute(){
    this.checkSource();
    if(this.getParam('outputSource')==='model'){
      this.outputData={'遮罩视频':this.modelOutput.output('video')};return;
    }
    const result=this.results.find(r=>r.category===this.getParam('outputCategory'));
    const ready=!!result&&!this.maskTask?.needsReanalysis&&!this.busy&&!this.dirty&&this.document&&this.maskTask&&this.maskTask.confirmedRevision===this.document.revision
      &&this.maskTask.exportMode===this.outputMode()&&this.maskTask.exportCategory===this.getParam('outputCategory')&&this.inputMatches();
    this.outputData={'遮罩视频':ready?{kind:'video-source',hudState:'ready',originalFps:result.fps,resolution:{w:result.width,h:result.height},
      duration:result.duration,audio:{hasAudio:result.hasAudio},processedAsset:{id:`${this.maskTask.exportId}-${result.category}`,url:result.url,filename:result.filename},fpsConvertMode:'none',targetFps:null,
      videoWidth:result.width,videoHeight:result.height}: {kind:'video-source',hudState:this.busy?'running':'idle',message:this.message||'请先确认并生成遮罩视频'},
      };
  }
  jobMatchesMode(job){return !job.stale&&!(this.getParam('outputCategory')==='dynamic'&&job.provenance?.detector==='trained'&&job.provenance.temporalRecovery!==(this.getParam('temporalRecovery')||'off'));}
  inputMatches(){const source=this.source();return !!source&&(!source.hudState||source.hudState==='ready')&&sourceIdentity(source)===this.maskTask?.sourceKey;}
  checkSource(){
    this.modelOutput.checkSource();
    const source=this.source(),key=sourceIdentity(source);
    const available=source&&(source.sourceFile||source.source?.sourceFile||videoSourceUrl(source));
    if(available&&key&&key===this.maskTask?.sourceKey)this.boundSourceKey=key;
    if(available&&this.boundSourceKey&&this.maskTask?.sourceKey&&key!==this.maskTask.sourceKey&&key!==this.boundSourceKey){
      this.editor?.close();const job=this.activeJobId;
      ++this.version;clearTimeout(this.timer);this.abort?.abort();this.busy=false;this.activeJobId=null;this.maskTask=null;this.document=null;this.results=[];this.dirty=false;
      if(job)localRequest(`/api/ui-mask/jobs/${job}/cancel`,post({})).catch(()=>{});
      this.message='输入视频已改变，请重新识别并确认遮罩';this.persist();
    }
    return available;
  }
  reset(){super.reset();this.checkSource();this.refresh();}
  onRendered(){
    if(!this.element)return;
    this.element.querySelector('.ui-mask-card')?.remove();clearInterval(this.syncTimer);
    const wrap=this.element.querySelector('.preview-wrap');wrap.replaceChildren();
    this.preview=document.createElement('video');this.preview.controls=false;this.preview.muted=true;this.preview.playsInline=true;this.preview.preload='metadata';this.preview.style.cssText='width:100%;height:100%;object-fit:contain;background:#000';wrap.appendChild(this.preview);
    const panel=document.createElement('div');panel.className='ui-mask-card';panel.innerHTML=`<div class="ui-mask-actions"><button data-mask="analyze">辅助识别</button><button data-mask="edit">手画遮罩</button><button data-mask="cancel">取消处理</button></div><p data-mask="message" role="status"></p><small data-mask="identity" style="display:block;white-space:pre-wrap;overflow-wrap:anywhere"></small><progress max="100" value="0" hidden></progress><label class="ui-mask-color">遮罩颜色<select data-mask="cover" aria-label="遮罩颜色"><option value="black">黑</option><option value="red">红</option><option value="green" selected>绿</option><option value="blue">蓝</option></select></label><button class="ui-mask-primary" data-mask="generate">确认并生成Mask视频</button><div class="ui-mask-results"></div><button type="button" class="ui-mask-open" data-mask="open">去除UI</button>`;
    const experimentButton=document.createElement('button');experimentButton.dataset.mask='experiment';experimentButton.textContent='实验模型 · 生成草稿';experimentButton.title='选择实验版本生成草稿；常规辅助识别保留原流程';panel.querySelector('.ui-mask-actions').append(experimentButton);
    wrap.after(panel);for(const event of ['mousedown','pointerdown','click'])panel.addEventListener(event,e=>e.stopPropagation());
    const outputNote=document.createElement('small');outputNote.className='ui-mask-output-note';outputNote.textContent='下游输出为 Mask 视频；黑白遮罩在生成后下载。';panel.append(outputNote);
    this.element.classList.add('ui-mask-node');const params=this.element.querySelector('.node-drag-handle')?.nextElementSibling;if(params&&params!==wrap)params.classList.add('ui-mask-node-params');const portArea=[...this.element.children].find(child=>child.querySelector?.('.port'));if(portArea)portArea.classList.add('ui-mask-node-ports');this.element.style.minHeight=`${this.getHeight()}px`;if(!this.element.dataset.maskHover){this.element.dataset.maskHover='1';this.element.addEventListener('pointerenter',()=>{if(this.preview)this.preview.controls=true;});this.element.addEventListener('pointerleave',()=>{if(this.preview)this.preview.controls=false;});}
    this.panel=panel;this.buttons=Object.fromEntries([...panel.querySelectorAll('[data-mask]')].map(e=>[e.dataset.mask,e]));
    this.buttons.analyze.onclick=()=>this.analyze();this.buttons.edit.onclick=()=>{
      if(this.getParam('outputSource')!=='model')return this.openEditor();
      if(this.modelOutput.draftReady())return this.modelOutput.editSession.open();
      this.setParam('outputSource','editor');this.setParam('outputCategory','dynamic');this.openEditor();
    };
    this.buttons.cancel.onclick=()=>this.getParam('outputSource')==='model'?this.modelOutput.editSession?.cancel():this.cancel();
    this.coverColor||='green';this.buttons.cover.value=this.coverColor;this.buttons.cover.onchange=()=>{this.coverColor=this.buttons.cover.value;};this.buttons.generate.onclick=()=>this.getParam('outputSource')==='model'?this.modelOutput.editSession?.generate(this.coverColor||'green'):this.generate();
    experimentButton.onclick=()=>this.openExperiment();this.buttons.open.onclick=()=>this.openEditor();
    this.syncTimer=setInterval(()=>{this.checkSource();this.refresh();},800);this.refresh();if(this.getParam('outputSource')!=='model')this.restore();
  }
  refresh(){
    this.editor?.refreshJob();
    if(!this.panel||this.disposed)return;
    const modelMode=this.getParam('outputSource')==='model',modelChecking=this.modelOutput.state==='checking',session=this.modelOutput.editSession,busy=this.busy||(modelMode&&session?.busy);
    session?.editor?.refreshJob();
    this.buttons.message.textContent=modelMode?this.modelOutput.message:this.message;
    if(this.buttons.identity){const p=this.maskTask?.provenance;this.buttons.identity.textContent=modelMode?'':p?`节点修订 r1 · ${p.temporalRecovery==='guarded-v2'?'保守跨帧试用（未验收）':'标准'}\n模型 ${p.modelVersion||p.detector} · 权重 ${p.weightsSha256?.slice(0,12)||'无'}\n识别 ${this.maskTask.id.slice(0,8)} · 输出 ${this.maskTask.exportId?.slice(0,8)||'未生成'} · 输入 ${this.document?.source.sha256.slice(0,12)||'未读取'}\n算法 ${p.pipelineVersion}`:'节点修订 r1 · 尚未记录本次识别版本';}
    const available=!!this.source(),category=this.getParam('outputCategory');this.buttons.analyze.disabled=busy||modelChecking||!available;this.buttons.edit.disabled=busy||modelChecking||!available;if(this.buttons.open)this.buttons.open.disabled=false;
    if(this.buttons.experiment){this.buttons.experiment.disabled=busy||modelChecking;this.buttons.experiment.textContent='实验模型 · 生成草稿';}
    this.buttons.analyze.hidden=modelMode;this.buttons.edit.hidden=false;this.buttons.generate.hidden=false;
    this.buttons.analyze.textContent=`辅助识别${category==='static'?'静态':'动态'} UI`;this.buttons.edit.textContent=modelMode?(this.modelOutput.draftReady()?'手动修正遮罩':'手动绘制遮罩'):(this.document?'手画 / 修改遮罩':'手画遮罩');
    this.buttons.cancel.hidden=!busy&&!this.activeJobId;this.buttons.generate.textContent='确认并生成Mask视频';if(this.buttons.cover){this.buttons.cover.value=this.coverColor||'green';this.buttons.cover.disabled=busy||modelChecking;}
    this.buttons.generate.disabled=modelMode?(busy||modelChecking||!this.modelOutput.draftReady()):(this.busy||this.maskTask?.needsReanalysis||!this.document||!this.inputMatches()||!this.document.tracks.some(t=>t.kind===category&&t.enabled&&t.ranges.length));
    if(this.getParam('detector')==='panel')super.setParam('detector','auto');
    for(const key of ['outputCategory','dynamicMode','detector','temporalRecovery']){const control=this.element.querySelector(`[data-key="${key}"]`);if(control){const row=control.closest('.node-param')||control.parentElement;const hidden=modelMode||(['dynamicMode','temporalRecovery'].includes(key)&&category==='static');row.hidden=hidden;row.style.display=hidden?'none':'flex';control.value=this.getParam(key)==='panel'?'auto':this.getParam(key);}}
    const sourceControl=this.element.querySelector('[data-key="outputSource"]');if(sourceControl)sourceControl.value=this.getParam('outputSource');
    for(const control of this.element.querySelectorAll('[data-key]'))control.disabled=busy||modelChecking;
    const progress=this.panel.querySelector('progress');progress.hidden=!busy;progress.value=(modelMode?session?.progress:this.progress)||0;
    const result=modelMode?(this.modelOutput.ready()?session.results[0]:null):this.results.find(r=>r.category===this.getParam('outputCategory'));
    const source=this.source();let src=result?.url||videoSourceUrl(source);
    if(!result&&source?.sourceFile){if(this.previewFile!==source.sourceFile){if(this.objectUrl)URL.revokeObjectURL(this.objectUrl);this.objectUrl=URL.createObjectURL(source.sourceFile);this.previewFile=source.sourceFile;}src=this.objectUrl;}
    if(src&&this.preview.getAttribute('src')!==src)this.preview.src=src;
    if(!src&&this.preview.hasAttribute('src')){this.preview.removeAttribute('src');this.preview.load();}
    const output=this.panel.querySelector('.ui-mask-results');
    const modelLinks=modelMode?this.modelOutput.downloads():null,signature=JSON.stringify(modelMode?modelLinks:this.results);
    if(modelMode){
      if(signature!==this.resultSignature){this.resultSignature=signature;output.replaceChildren();for(const item of modelLinks){const a=document.createElement('a');a.href=item.url;a.textContent=item.label;a.download='';output.append(a);}}
      this.modelOutput.restore();
    }else{
    if(signature!==this.resultSignature){this.resultSignature=signature;output.replaceChildren();for(const r of this.results){const row=document.createElement('div'),a=document.createElement('a');
      a.href=r.downloadUrl;a.textContent=r.category==='static'?'下载静态Mask遮罩视频':`下载动态${r.mode==='follow'?'跟随':'拖尾'}Mask遮罩视频`;a.download=r.filename;row.append(a);output.appendChild(row);}}
    }
    requestAnimationFrame(()=>{if(this.element?.isConnected)window.editor?.updateConnections();});
  }
  async analyze(operation='detect',options={}){
    if(this.busy||this.disposed)return;
    const source=this.source();if(!source)return this.show('请连接视频素材');
    if(source.targetFps)return this.show('请连接原视频素材；转换帧率后请先导出，再作为新素材输入');
    if(!options.keepEditor)this.editor?.close();try{await this.flushDocument();}catch(error){return this.show(`请先保存当前修改：${error.message}`);}
    const version=++this.version,category=this.getParam('outputCategory');this.busy=true;this.jobStartedAt=Date.now();this.activeJobId=null;this.results=[];this.progress=0;this.abort=new AbortController();this.openAfterPrepare=operation==='manual';this.show(operation==='manual'?'读取视频，准备手画遮罩…':'准备识别本类 UI…');this.propagate();
    let allocated=null;
    try{
      let file,created;
      const detector=this.requestedDetector();
      if(this.document&&this.maskTask?.id&&this.inputMatches())created=await localRequest(`/api/ui-mask/jobs/${this.maskTask.id}/analyze`,post({category,revision:this.document.revision,detector,temporalRecovery:this.getParam('temporalRecovery')}));
      else{file=await videoSourceFile(source,this.abort.signal);if(!file)throw new Error('输入视频未加载完成');created=await localRequest('/api/ui-mask/jobs',post({filename:file.name,category,operation,detector,temporalRecovery:this.getParam('temporalRecovery')}));}
      allocated=created.id;
      if(version!==this.version||this.disposed){await localRequest(`/api/ui-mask/jobs/${allocated}/cancel`,post({}));return;}
      this.activeJobId=allocated;
      if(!this.maskTask)this.maskTask={id:allocated,sourceKey:sourceIdentity(source),exportId:null,confirmedRevision:null};
      this.maskTask.pendingAnalysis={id:allocated,sourceKey:sourceIdentity(source),operation};this.persist();
      if(file)await localRequest(`/api/ui-mask/jobs/${allocated}/source`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file,signal:this.abort.signal});
      if(version===this.version)this.poll(allocated,'analysis',version);
    }catch(error){if(allocated)localRequest(`/api/ui-mask/jobs/${allocated}/cancel`,post({})).catch(()=>{});if(version===this.version){this.busy=false;this.show(error.name==='AbortError'?'已取消':error.message);this.propagate();}}
  }
  async poll(id,kind,version){
    if(version!==this.version||this.disposed)return;
    try{
      const job=await localRequest(`/api/ui-mask/jobs/${id}`);if(version!==this.version||this.disposed)return;
      this.progress=job.progress;this.message=job.message;
      if(job.state==='ready'){
        this.busy=false;this.activeJobId=null;
        if(kind==='analysis'){
          const pending=this.maskTask.pendingAnalysis;
          this.maskTask={id,sourceKey:pending?.sourceKey||this.maskTask.sourceKey,exportId:null,confirmedRevision:null};
          this.maskTask.provenance=job.provenance;this.maskTask.needsReanalysis=!this.jobMatchesMode(job);
          this.document=validateMaskDocument(job.document);this.dirty=false;this.editVersion=0;this.migrateMasks();
          if(this.editor&&!this.editor.closed){this.editor.selected=null;this.editor.render();this.editor.rebuildUnion();}
          this.show(job.message||(job.operation==='manual'?'视频已就绪，可直接手画遮罩':'辅助识别完成，请检查与修改。'));
          if(this.openAfterPrepare||pending?.operation==='manual'){this.openAfterPrepare=false;this.openEditor();}
        }else if(this.jobMatchesMode(job)&&this.document&&job.revision===this.document.revision&&job.mode===this.outputMode()&&job.category===this.getParam('outputCategory')&&!this.dirty){
          this.results=job.results;this.maskTask.confirmedRevision=job.revision;this.maskTask.exportMode=job.mode;this.maskTask.exportCategory=job.category;
        }else{
          this.results=[];this.maskTask.exportId=null;this.maskTask.confirmedRevision=null;this.show('已有输出与当前范围或类别不同，请重新确认生成');
        }
        this.persist();this.refresh();this.propagate();return;
      }
      if(['failed','cancelled'].includes(job.state)){this.busy=false;this.activeJobId=null;if(this.maskTask)delete this.maskTask.pendingAnalysis;this.persist();this.refresh();this.propagate();return;}
    }catch(error){if(version!==this.version)return;this.busy=false;this.show(`读取任务失败：${error.message}。重新打开节点可恢复。`);this.propagate();return;}
    this.refresh();this.timer=setTimeout(()=>this.poll(id,kind,version),1000);
  }
  async restore(){
    if(this.restored||!this.maskTask?.id||this.busy)return;this.restored=true;const version=++this.version;
    try{
      if(this.maskTask.forkOnEdit){
        const fork=await localRequest(`/api/ui-mask/jobs/${this.maskTask.id}/fork`,post({}));
        if(version!==this.version||this.disposed)return;
        this.maskTask={...this.maskTask,id:fork.id,forkOnEdit:false,exportId:null,confirmedRevision:null,pendingAnalysis:null};this.persist();
      }
      const job=await localRequest(`/api/ui-mask/jobs/${this.maskTask.id}`);if(version!==this.version||this.disposed)return;
      if(this.maskTask.pendingAnalysis?.operation==='manual'){delete this.maskTask.pendingAnalysis;this.busy=false;this.activeJobId=null;}
      if(this.maskTask.pendingAnalysis){this.busy=true;this.activeJobId=this.maskTask.pendingAnalysis.id;this.poll(this.activeJobId,'analysis',version);}
      else if(job.state==='ready'){
        this.document=validateMaskDocument(job.document);this.dirty=false;this.migrateMasks();
        this.maskTask.provenance=job.provenance;this.maskTask.needsReanalysis=!this.jobMatchesMode(job);
        if(!this.jobMatchesMode(job)){this.results=[];this.maskTask.exportId=null;this.maskTask.confirmedRevision=null;this.show('旧任务与当前算法或权重不匹配，请重新辅助识别；手动修改保留');this.persist();this.propagate();return;}
        if(this.maskTask.exportId&&!this.dirty&&this.maskTask.exportCategory===this.getParam('outputCategory')&&this.maskTask.exportMode===this.outputMode()){this.busy=true;this.activeJobId=this.maskTask.exportId;this.poll(this.maskTask.exportId,'export',version);}
        else{this.maskTask.exportId=null;this.maskTask.confirmedRevision=null;this.persist();this.show('已恢复遮罩，可继续检查与修改');}
      }else if(job.state==='running'&&job.operation==='manual'){this.busy=false;this.activeJobId=null;localRequest(`/api/ui-mask/jobs/${this.maskTask.id}/cancel`,post({})).catch(()=>{});this.show('已停止读取视频。去除UI只打开编辑窗口。');}
      else if(job.state==='running'){this.busy=true;this.activeJobId=this.maskTask.id;this.poll(this.maskTask.id,'analysis',version);}
      else this.show(job.message||'请重新识别UI');
    }catch(error){this.show(`无法恢复遮罩：${error.message}。原记录保留，可重新识别。`);}
    this.refresh();this.propagate();
  }
  migrateMasks(){
    if(!this.legacyMasks?.length||!this.document)return;
    const s=this.document.source;
    this.legacyMasks.forEach((points,i)=>{
      if(points.length<3)return;const polygon=[];
      for(let n=0;n<points.length;n++){const p=points[n],q=points[(n+1)%points.length];for(let step=0;step<16;step++){const t=step/16,u=1-t;polygon.push([u*u*u*p.x+3*u*u*t*(p.h2x??p.x)+3*u*t*t*(q.h1x??q.x)+t*t*t*q.x,u*u*u*p.y+3*u*u*t*(p.h2y??p.y)+3*u*t*t*(q.h1y??q.y)+t*t*t*q.y].map(v=>Math.max(0,Math.min(1,v))));}}
      const xs=polygon.map(p=>p[0]),ys=polygon.map(p=>p[1]);const oldRanges=this.legacyRanges?.[i];
      const window=this.legacyWindow||{start:0,end:null},ceiling=time=>{const index=s.times.findIndex(t=>t+1e-6>=time);return index<0?s.frames:index;};
      const ranges=(oldRanges??[{start:0,end:null}]).map(r=>[ceiling(Math.max(r.start,window.start)),ceiling(Math.min(r.end??s.duration,window.end??s.duration))]).filter(([a,b])=>a<b);
      this.document.tracks.push({id:`legacy-${i}`,label:`原有静态遮罩 ${i+1}`,kind:'static',enabled:true,origin:'manual',classificationLocked:true,ranges,samples:[{frame:0,box:[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]}],keys:[],overrides:[],polygon});
    });
    this.legacyMasks=null;this.legacyRanges=null;this.legacyWindow=null;this.documentChanged();this.persist();
  }
  openEditor(){
    if(this.opening)return;
    if(this.editor?.closed)this.editor=null;
    if(this.openAfterPrepare)this.cancel();
    if(this.busy)return this.show('正在处理，请等当前任务结束再打开');
    try{
      if(this.document&&this.maskTask?.id){this.editor??=new UiMaskEditor(this);return;}
      if(this.maskTask?.id){this.openSavedEditor();return;}
    }catch(error){return this.show(`无法打开编辑窗口：${error.message}`);}
    this.show('这个节点还没有遮罩稿，正在读取视频后打开');
    this.analyze('manual');
  }
  async openSavedEditor(){
    this.opening=true;
    try{
      const job=await localRequest(`/api/ui-mask/jobs/${this.maskTask.id}`);
      if(!job.document){this.show(job.message||'遮罩稿还没准备好');return;}
      this.document=validateMaskDocument(job.document);this.dirty=false;
      this.editor??=new UiMaskEditor(this);
    }catch(error){this.show(`无法打开遮罩：${error.message}`);}
    finally{this.opening=false;}
  }
  documentChanged(){
    ++this.editVersion;this.dirty=true;this.results=[];if(this.maskTask){this.maskTask.exportId=null;this.maskTask.confirmedRevision=null;}
    this.persist();
    this.show('遮罩已修改，请确认后生成黑色遮罩视频');this.propagate();clearTimeout(this.saveTimer);
    this.saveTimer=setTimeout(()=>this.flushDocument().catch(e=>{this.show(`遮罩尚未保存：${e.message}`);this.editor?.status(this.message);}),350);
  }
  async flushDocument(){
    clearTimeout(this.saveTimer);if(this.saving)return this.saving;if(!this.dirty||!this.document||!this.maskTask)return;
    const id=this.maskTask.id;
    this.saving=(async()=>{while(this.dirty&&this.maskTask?.id===id){
      const version=this.editVersion,document=structuredClone(this.document);validateMaskDocument(document);
      const result=await localRequest(`/api/ui-mask/jobs/${id}/document`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:document.revision,document})});
      if(this.maskTask?.id!==id)return;
      this.document.revision=result.revision;this.dirty=version!==this.editVersion;
      this.editor?.status(this.dirty?'保存修改中…':'修改已自动保存，确认范围后生成黑色遮罩视频');
    }})().finally(()=>{this.saving=null;});return this.saving;
  }
  async generate(){
    if(this.maskTask?.needsReanalysis)return this.show('请先重新辅助识别，再生成当前版本结果');
    if(this.busy||!this.document)return;if(!this.inputMatches()&&!this.maskTask?.id)return this.show('请先连接同一段视频');
    this.busy=true;this.jobStartedAt=Date.now();this.activeJobId=null;this.results=[];this.show('保存已确认的遮罩范围…');this.propagate();
    const version=++this.version;let allocated=null;
    try{
      await this.flushDocument();if(version!==this.version)return;if(!this.inputMatches()){this.busy=false;this.show('输入视频已改变，请重新检查');return;}
      const mode=this.outputMode(),category=this.getParam('outputCategory'),revision=this.document.revision;
      const job=await localRequest(`/api/ui-mask/jobs/${this.maskTask.id}/export`,post({confirmed:true,mode,category,revision,coverColor:this.coverColor||'green'}));allocated=job.id;
      if(version!==this.version||this.disposed){await localRequest(`/api/ui-mask/jobs/${allocated}/cancel`,post({}));return;}
      this.activeJobId=job.id;this.maskTask.exportId=job.id;this.maskTask.exportMode=mode;this.maskTask.exportCategory=category;this.maskTask.confirmedRevision=null;this.persist();this.poll(job.id,'export',version);
    }catch(error){if(allocated)localRequest(`/api/ui-mask/jobs/${allocated}/cancel`,post({})).catch(()=>{});if(version===this.version){this.busy=false;this.show(error.message);this.propagate();}}
  }
  async cancel(){
    const version=++this.version;clearTimeout(this.timer);this.abort?.abort();const id=this.activeJobId;
    this.busy=false;this.activeJobId=null;this.results=[];if(this.maskTask){this.maskTask.confirmedRevision=null;delete this.maskTask.pendingAnalysis;}this.openAfterPrepare=false;this.persist();
    if(id)await localRequest(`/api/ui-mask/jobs/${id}/cancel`,post({})).catch(()=>{});
    if(version!==this.version)return;
    this.show('已取消，可继续检查或重新执行');this.propagate();
  }
  dispose(){this.editor?.close();this.experiment?.close();this.modelOutput.dispose();this.flushDocument().catch(()=>{});this.cancel();this.disposed=true;clearTimeout(this.timer);clearTimeout(this.saveTimer);clearInterval(this.syncTimer);this.preview?.pause();if(this.objectUrl)URL.revokeObjectURL(this.objectUrl);super.dispose();}
}
