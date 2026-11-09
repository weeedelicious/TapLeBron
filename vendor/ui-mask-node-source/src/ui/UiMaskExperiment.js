import { localRequest, videoSourceFile } from '../utils/LocalVideo.js';
import {UiMaskRunTiming} from './UiMaskRunTiming.js';
import {UiMaskFrameLoader} from './UiMaskFrameLoader.js';
// Shotflow：样式由 public/ui-mask-bridge.js 用 <link> 加载（浏览器不能直接 import .css）

const post=data=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const remembered='ui-mask-contour-experiment-job';
const rememberedModel='ui-mask-contour-experiment-model';

export class UiMaskExperiment {
  constructor(node, {preferredVersion=null}={}) {
    this.preferredVersion=preferredVersion;
    this.node=node;this.frame=0;this.viewVersion=0;this.running=false;
    this.images=new UiMaskFrameLoader();
    this.dialog=document.createElement('dialog');this.dialog.className='mask-experiment';
    this.dialog.innerHTML=`<header><div><h2>${preferredVersion?'动态 UI · 文字组件试用':'实验模型 · 批量轮廓验证'}</h2><p>从当前输入视频运行所选识别方案，生成可手动修正的遮罩草稿</p></div><button data-action="close">关闭</button></header>
      <section class="experiment-setup"><label>模型 <select data-field="model" aria-label="实验模型"></select></label><label>另选视频 <input data-field="file" type="file" accept="video/*"></label><button data-action="run" disabled>运行当前输入视频</button><button data-action="cancel" disabled>取消任务</button><p data-view="limits">正在读取本机模型…</p></section>
      <p class="experiment-notice">第二阶段请输入已完成静态修复的视频。检测只生成草稿；载入后可半透明查看、手动补遮或擦除误遮，确认后再生成 Mask 视频。<span data-view="model-note"></span></p>
      <div class="experiment-status"><span data-view="status" role="status"></span><progress max="100" value="0" hidden></progress></div>
      <div class="experiment-timing"><strong data-view="elapsed" aria-label="识别完整耗时"></strong><details><summary>查看分段耗时</summary><p data-view="timing"></p></details></div><button data-action="retry-frame" hidden>重试当前帧图片</button>
      <section class="experiment-result" hidden><div class="experiment-transport"><button data-action="first">首帧</button><button data-action="previous">上一帧</button><button data-action="play">慢放</button><button data-action="next">下一帧</button><button data-action="last">末帧</button><input data-field="seek" aria-label="实验视频进度" type="range" min="0" value="0"><label>帧 <input data-field="frame" aria-label="实验当前帧" type="number" min="1" value="1"></label><span data-view="time"></span><label><input data-field="mask" type="checkbox">显示纯遮罩</label></div>
      <div class="experiment-images"><figure><figcaption>原始帧</figcaption><img data-image="source" alt="原始视频帧"></figure><figure><figcaption>所选模型自动 Mask · 含 4px 安全边</figcaption><img data-image="covered" alt="所选模型自动 Mask 结果"></figure><figure data-view="mask-panel" hidden><figcaption>同一修复遮罩 · 白色为修复范围</figcaption><img data-image="repair" alt="当前帧纯修复遮罩"></figure></div>
      <footer><span data-view="identity"></span><div data-view="downloads"></div><button data-action="apply" disabled>载入遮罩草稿</button></footer></section>`;
    document.body.append(this.dialog);this.dialog.showModal();
    this.dialog.addEventListener('cancel',e=>{e.preventDefault();this.close();});
    this.$('[data-action="close"]').onclick=()=>this.close();
    this.$('[data-action="run"]').onclick=()=>this.run();
    this.$('[data-action="cancel"]').onclick=()=>this.cancel();
    this.$('[data-action="apply"]').onclick=()=>this.apply();
    this.$('[data-action="retry-frame"]').onclick=()=>this.result?this.seek(this.requestedFrame??0):this.poll();
    for(const [action,target] of [['first',()=>0],['last',()=>this.result.source.frames-1],['previous',()=>this.frame-1],['next',()=>this.frame+1]])
      this.$(`[data-action="${action}"]`).onclick=()=>{this.pause();this.seek(target());};
    this.$('[data-action="play"]').onclick=()=>this.playing?this.pause():this.play();
    this.field('seek').oninput=()=>{this.pause();this.seek(Number(this.field('seek').value));};
    this.field('frame').onchange=()=>{this.pause();this.seek(Number(this.field('frame').value)-1);};
    this.field('mask').onchange=()=>this.seek(this.requestedFrame??this.frame);
    this.field('file').onchange=()=>{this.$('[data-action="run"]').textContent=this.field('file').files.length?'运行所选视频':'运行当前输入视频';};
    this.field('model').onchange=()=>this.selectModel(this.field('model').value);
    this.onVisibility=()=>{
      this.timing?.visibility(document.hidden);this.refreshTiming();
      if(!document.hidden&&!this.closed){
        this.finishFirstFrame();
        if(this.id&&!this.result&&!this.uploading&&!this.loadingSelection)this.poll();
      }
    };
    document.addEventListener('visibilitychange',this.onVisibility);
    this.init();
  }
  $(selector){return this.dialog.querySelector(selector);}
  field(name){return this.$(`[data-field="${name}"]`);}
  status(text){this.$('[data-view="status"]').textContent=text;}
  resetTiming(mode){
    clearInterval(this.timingTimer);this.timing=new UiMaskRunTiming(mode,()=>performance.now(),document.hidden);
    this.timingSaveFailed=false;this.firstDecoded=false;this.frameReady=false;this.lastRunTiming=null;
    this.timingTimer=setInterval(()=>this.refreshTiming(),500);this.refreshTiming();
  }
  refreshTiming(){
    if(!this.timing||this.closed)return;
    const previous=this.timing.mode==='restore'&&this.lastRunTiming?.completed?`上次运行总等待 ${this.lastRunTiming.totalSeconds.toFixed(1)}秒。`:'';
    const data=this.timing.snapshot();
    this.$('[data-view="elapsed"]').textContent=`${this.timing.mode==='run'?'本次运行总等待':'本次打开结果'} ${data.totalSeconds.toFixed(1)}秒${data.completed?' · 首帧已显示':this.timing.stopped!=null?' · 已停止':' · 等待首帧显示'}${Number.isFinite(data.backendSeconds)?`；后台计算 ${data.backendSeconds.toFixed(1)}秒`:''}`;
    this.$('[data-view="timing"]').textContent=previous+this.timing.text()+(this.timingSaveFailed?' 计时日志保存失败，页面计时仍有效。':'');
  }
  saveTiming(){
    if(!this.id||!this.timing)return;
    const timing=this.timing,id=this.id;
    localRequest(`/api/ui-mask/jobs/${id}/client-timing`,{...post(timing.snapshot()),keepalive:true}).then(()=>{
      if(timing===this.timing){this.timingSaveFailed=false;this.refreshTiming();}
    }).catch(()=>{if(timing===this.timing){this.timingSaveFailed=true;this.refreshTiming();}});
  }
  finishFirstFrame(){
    if(!this.firstDecoded||document.hidden||!this.timing||this.timing.marks.visible!=null||this.paintScheduled||this.closed)return;
    const timing=this.timing,id=this.id;this.paintScheduled=true;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      this.paintScheduled=false;
      if(this.closed||timing!==this.timing||id!==this.id||document.hidden)return;
      timing.mark('visible');clearInterval(this.timingTimer);this.refreshTiming();this.saveTiming();
    }));
  }
  async init(){
    try{
      const registry=await localRequest('/api/ui-mask/experiments/models');
      if(this.closed)return;
      this.models=registry.models;
      if(!this.models.length)throw new Error('实验模型未安装');
      for(const model of this.models)this.field('model').add(new Option(model.label,model.version));
      this.$('[data-view="limits"]').textContent='正在读取本机模型…';
      const saved=localStorage.getItem(rememberedModel);
      if(this.preferredVersion&&!this.models.some(model=>model.version===this.preferredVersion))throw new Error('动态关联方案未安装，请检查服务配置');
      await this.selectModel(this.preferredVersion||this.models.find(model=>model.version===(this.node.modelMaskTask?.modelVersion||saved))?.version||this.models.find(model=>model.applicationDefault)?.version||this.models[0].version);
    }catch(error){this.status(error.message);}
  }
  async selectModel(version){
    if(this.running||this.applying)return;
    const model=this.models?.find(item=>item.version===version);if(!model)return;
    const selection=this.selectionVersion=(this.selectionVersion||0)+1;
    this.cancelledId=null;
    this.resetTiming('restore');this.images.clear();this.loadingImages=false;
    this.restorePosition=this.result?{sha256:this.result.source.sha256,frame:this.frame}:null;
    this.pause();clearTimeout(this.pollTimer);this.id=null;this.result=null;++this.viewVersion;
    this.$('.experiment-result').hidden=true;this.model=model;this.field('model').value=version;
    this.$('[data-view="model-note"]').textContent=model.notice?` ${model.notice}`:'';
    this.$('[data-view="limits"]').textContent=`当前模型最多 ${model.maxWidth}×${model.maxHeight}、${model.maxDuration} 秒、${model.maxFrames} 帧；保持原分辨率。可直接运行节点输入，或另选视频。`;
    localStorage.setItem(rememberedModel,version);
    this.loadingSelection=true;this.controls(false);this.status('读取所选模型的最近结果…');
    try{
      const recent=await localRequest(`/api/ui-mask/experiments/recent?version=${encodeURIComponent(version)}`);
      if(this.closed||selection!==this.selectionVersion)return;
      const bound=this.node.modelMaskTask;
      const previous=(bound?.modelVersion===version?bound.id:null)||recent.id||localStorage.getItem(`${remembered}:${version}`);
      this.loadingSelection=false;this.controls(false);
      this.status(model.available?`${model.label}已就绪。${model.notice||''}`:'实验模型文件或运行环境缺失');
      if(previous&&/^[a-f0-9-]{36}$/.test(previous)){this.id=previous;await this.poll();}
      else{clearInterval(this.timingTimer);this.timing=null;this.$('[data-view="elapsed"]').textContent='尚未开始识别';this.$('[data-view="timing"]').textContent='点击运行后开始记录完整等待时间。';}
    }catch(error){if(!this.closed&&selection===this.selectionVersion)this.status(error.message);}
    finally{if(selection===this.selectionVersion){this.loadingSelection=false;if(!this.closed)this.controls(this.running);}}
  }
  controls(running){
    this.running=running;
    this.$('[data-action="run"]').disabled=running||this.applying||this.loadingSelection||!this.model?.available;
    this.$('[data-action="cancel"]').disabled=!running;
    this.field('file').disabled=running||this.applying;this.field('model').disabled=running||this.applying;
    this.$('[data-action="apply"]').disabled=running||this.applying||this.loadingImages||!this.result||!this.frameReady;
    this.$('progress').hidden=!running;
  }
  async run(){
    if(this.running||this.applying||this.loadingSelection)return;this.pause();this.controls(true);this.status('准备输入视频…');
    this.resetTiming('run');++this.viewVersion;this.images.clear();this.$('[data-action="retry-frame"]').hidden=true;
    this.cancelledId=null;this.loadingImages=false;
    this.restorePosition=null;
    this.result=null;this.$('.experiment-result').hidden=true;this.id=null;
    const token=this.runToken={cancelled:false};
    this.inputAbort=new AbortController();
    try{
      const selected=this.field('file').files[0],source=this.node.source();
      if(!selected&&source?.targetFps)throw new Error('请连接原视频素材；转换帧率后请先导出，再选择导出文件');
      const file=selected||await videoSourceFile(source,this.inputAbort.signal);
      if(token.cancelled)return;
      if(!file)throw new Error('请连接原视频素材，或在此选择视频');
      this.timing.mark('input');this.refreshTiming();
      const made=await localRequest('/api/ui-mask/experiments',post({filename:file.name,modelVersion:this.model.version,draftOnly:true}));
      if(token.cancelled){await localRequest(`/api/ui-mask/jobs/${made.id}/cancel`,post({}));return;}
      this.id=made.id;localStorage.setItem(`${remembered}:${this.model.version}`,this.id);
      this.timing.mark('created');this.saveTiming();
      this.status('上传视频，随后运行所选检测方案…');
      this.uploading=true;
      await localRequest(`/api/ui-mask/jobs/${this.id}/source`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file,signal:this.inputAbort.signal});
      this.uploading=false;this.timing.mark('uploaded');this.saveTiming();
      if(token===this.runToken&&!token.cancelled&&!this.closed)await this.poll();
    }catch(error){if(token!==this.runToken)return;this.uploading=false;if(!token.cancelled)this.status(error.message);this.timing?.stop();clearInterval(this.timingTimer);this.refreshTiming();this.saveTiming();this.controls(false);}
  }
  async poll(){
    clearTimeout(this.pollTimer);
    if(this.closed||!this.id||this.id===this.cancelledId)return;
    const id=this.id;
    if(this.pollingId===id)return;
    this.pollingId=id;
    const abort=this.pollAbort=new AbortController(),timeout=setTimeout(()=>abort.abort(),15000);
    try{
      const job=await localRequest(`/api/ui-mask/jobs/${id}`,{signal:abort.signal});
      if(this.closed||id!==this.id||id===this.cancelledId)return;
      if(job.modelVersion!==this.model.version)throw new Error('保存的任务与所选模型不一致，请重新运行');
      this.status(job.message);this.$('progress').value=job.progress||0;
      if(job.state==='ready'){
        this.timing.backendSeconds=job.elapsed;this.timing.resultPickupSeconds=this.timing.mode==='run'?job.timing?.readyToQuerySeconds:null;this.timing.mark('ready');this.lastRunTiming=job.timing?.latestClientRun;this.saveTiming();
        this.controls(false);this.result=job.experiment;
        if(!this.result)throw new Error('该任务不是实验检测结果');
        this.controls(false);
        this.$('.experiment-result').hidden=false;
        this.field('seek').max=this.result.source.frames-1;this.field('frame').max=this.result.source.frames;
        const info=this.result;
        this.$('[data-view="identity"]').textContent=`${info.source.filename} · ${info.modelVersion} · ${info.source.frames} 帧 · 4px 安全边 · 编码额外扩边 0px`;
        const links=this.$('[data-view="downloads"]');links.replaceChildren();
        links.textContent='载入草稿后可手动修正；视频在确认生成后下载。';
        const position=this.restorePosition;this.restorePosition=null;
        await this.seek(position?.sha256===info.source.sha256?position.frame:0);return;
      }
      if(['failed','cancelled'].includes(job.state)){this.timing?.stop();clearInterval(this.timingTimer);this.refreshTiming();this.saveTiming();this.controls(false);return;}
      this.controls(true);
      if(job.state==='waiting'){this.status('上次上传未完成，请重新运行');this.controls(false);return;}
      this.pollTimer=setTimeout(()=>this.poll(),1000);
    }catch(error){if(!this.closed&&id===this.id&&id!==this.cancelledId){this.status(error.name==='AbortError'?'读取任务状态超时，可重试；不需要重新识别':error.message);const button=this.$('[data-action="retry-frame"]');button.hidden=false;button.textContent='重试读取任务状态';this.controls(false);}}
    finally{clearTimeout(timeout);if(this.pollingId===id)this.pollingId=null;}
  }
  async seek(frame){
    if(!this.result||!Number.isFinite(frame)||this.closed)return;
    frame=Math.max(0,Math.min(this.result.source.frames-1,Math.round(frame)));
    const version=++this.viewVersion;
    this.requestedFrame=frame;this.loadingImages=true;this.controls(this.running);
    this.$('[data-view="mask-panel"]').hidden=true;this.$('[data-action="retry-frame"]').hidden=true;this.$('[data-action="retry-frame"]').textContent='重试当前帧图片';
    try{
      const images=await this.images.frame(this.id,frame,this.field('mask').checked);
      if(version!==this.viewVersion||this.closed)return;
      for(const [kind,img] of images){const old=this.$(`[data-image="${kind}"]`);if(old!==img){img.dataset.image=kind;img.alt=old.alt;old.replaceWith(img);}}
      this.$('[data-view="mask-panel"]').hidden=!this.field('mask').checked;
      this.frameReady=true;this.loadingImages=false;this.controls(this.running);
      this.$('[data-action="retry-frame"]').hidden=true;
      if(!this.firstDecoded){this.firstDecoded=true;this.timing?.mark('decoded');this.refreshTiming();this.saveTiming();this.finishFirstFrame();}
      this.status(`${this.result.modelLabel || this.model.label}草稿已显示，请检查漏遮与误遮；未声明准确率`);
      this.frame=frame;this.field('seek').value=frame;this.field('frame').value=frame+1;
      const row=this.result.frames[frame];
      const count=Number.isFinite(row.detections)?`${row.detections} 个候选`:`${row.repairPixels} 个遮罩像素`;
      this.$('[data-view="time"]').textContent=`/ ${this.result.source.frames} · ${row.pts.toFixed(3)}s · ${count}`;
      for(const action of ['first','previous'])this.$(`[data-action="${action}"]`).disabled=frame===0;
      for(const action of ['last','next'])this.$(`[data-action="${action}"]`).disabled=frame===this.result.source.frames-1;
      if(this.playing){
        if(frame===this.result.source.frames-1)this.pause();
        else this.playTimer=setTimeout(()=>this.seek(frame+1),Math.max(80,(this.result.source.times[frame+1]-row.pts)*4000));
      }
    }catch(error){if(version!==this.viewVersion||this.closed)return;this.loadingImages=false;this.controls(this.running);this.pause();this.$('[data-action="retry-frame"]').hidden=false;this.status(`后台结果已生成，帧图片读取失败：${error.message}`);this.saveTiming();}
  }
  play(){if(!this.result)return;this.playing=true;this.$('[data-action="play"]').textContent='暂停';this.seek(this.frame===this.result.source.frames-1?0:this.frame);}
  pause(){this.playing=false;clearTimeout(this.playTimer);this.$('[data-action="play"]').textContent='慢放';}
  async apply(){
    if(this.running||this.applying||!this.result)return;
    this.pause();this.applying=true;this.controls(false);this.status('核对当前节点输入与检测结果…');
    try{
      const adopted=await this.node.modelOutput.bind(this.id);
      if(!this.closed&&adopted)this.status('草稿已载入：关闭后点击“手动修正遮罩”，检查完成再“确认并生成Mask视频”');
    }catch(error){if(!this.closed)this.status(error.message);}
    finally{this.applying=false;if(!this.closed)this.controls(this.running);}
  }
  async cancel(){
    const token=this.runToken;
    if(this.runToken)this.runToken.cancelled=true;
    this.inputAbort?.abort();this.timing?.stop();this.refreshTiming();this.saveTiming();clearInterval(this.timingTimer);
    clearTimeout(this.pollTimer);
    const id=this.id;this.cancelledId=id;this.controls(false);this.status('正在取消实验任务…');
    try{if(id)await localRequest(`/api/ui-mask/jobs/${id}/cancel`,post({}));if(token===this.runToken&&!this.closed)this.status('实验任务已请求取消');}
    catch(error){if(token===this.runToken&&!this.closed)this.status(error.message);}
  }
  close(){this.timing?.stop();this.saveTiming();this.closed=true;this.pollAbort?.abort();this.pause();clearTimeout(this.pollTimer);clearInterval(this.timingTimer);document.removeEventListener('visibilitychange',this.onVisibility);this.images.clear();this.viewVersion++;this.dialog.close();this.dialog.remove();}
}
