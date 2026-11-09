import { localRequest } from '../utils/LocalVideo.js';
import { validateMaskDocument } from './UiMaskDocument.js';
import { UiMaskEditor } from '../ui/UiMaskEditor.js';

const post=data=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});

// Adapter for the established drawing/timing editor. Original model pixels stay immutable.
export class UiMaskModelEdit {
  constructor(owner,reference,document){this.owner=owner;this.maskTask=reference;this.document=validateMaskDocument(document);this.results=[];this.busy=false;this.dirty=false;this.editVersion=0;this.generation=0;this.message='草稿已就绪，可手动修正；确认后生成 Mask 视频';}
  getParam(name){return name==='outputCategory'?'dynamic':name==='dynamicMode'?'follow':null;}
  setParam(){this.show('当前仅编辑动态阶段草稿，静态修复单独进行');}
  valid(){return !this.closed&&this.owner.matches();}
  changed(){if(this.closed)return;this.owner.message=this.message;this.owner.changed();this.editor?.refreshJob();}
  show(message){this.message=message;this.changed();}
  async restore(){
    if(this.maskTask.exportId&&!this.dirty){this.busy=true;await this.poll(this.maskTask.exportId);}
  }
  open(){if(!this.valid()||this.busy)return;this.editor??=new UiMaskEditor(this);}
  documentChanged(){
    ++this.editVersion;this.dirty=true;this.results=[];this.maskTask.exportId=null;this.maskTask.confirmedRevision=null;
    this.show('草稿已修改，保存后请确认生成 Mask 视频');clearTimeout(this.saveTimer);
    this.saveTimer=setTimeout(()=>this.flushDocument().catch(e=>this.show(`草稿保存失败：${e.message}`)),350);
  }
  async flushDocument(){
    clearTimeout(this.saveTimer);if(this.saving)return this.saving;
    if(!this.dirty)return;
    this.saving=(async()=>{while(this.dirty){
      const version=this.editVersion,document=structuredClone(this.document);validateMaskDocument(document);
      const result=await localRequest(`/api/ui-mask/jobs/${this.maskTask.id}/document`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:document.revision,document})});
      this.document.revision=result.revision;this.dirty=this.editVersion!==version;
    }})().finally(()=>{this.saving=null;});return this.saving;
  }
  async generate(coverColor='green'){
    if(this.busy||!this.valid())return;
    const generation=++this.generation;
    this.busy=true;this.results=[];this.show('保存草稿并生成 Mask 视频…');
    try{
      await this.flushDocument();if(!this.valid()||generation!==this.generation)return;
      const result=await localRequest(`/api/ui-mask/jobs/${this.maskTask.id}/export`,post({confirmed:true,category:'dynamic',mode:'follow',revision:this.document.revision,coverColor}));
      if(!this.valid()||generation!==this.generation){await localRequest(`/api/ui-mask/jobs/${result.id}/cancel`,post({}));return;}
      this.maskTask.exportId=result.id;this.maskTask.confirmedRevision=null;this.changed();await this.poll(result.id);
    }catch(error){this.busy=false;this.show(error.message);}
  }
  async poll(id){
    clearTimeout(this.timer);if(!this.valid())return;
    try{
      const job=await localRequest(`/api/ui-mask/jobs/${id}`);if(!this.valid()||this.maskTask.exportId!==id)return;
      this.progress=job.progress||0;
      if(job.state==='ready'){
        this.busy=false;
        if(job.revision!==this.document.revision||this.dirty||job.category!=='dynamic'||job.mode!=='follow')throw new Error('草稿已改变，请重新确认生成');
        this.results=job.results;this.maskTask.confirmedRevision=job.revision;this.show('Mask 视频已生成，可连接下游；纯遮罩可下载');return;
      }
      if(['failed','cancelled'].includes(job.state)){this.busy=false;this.show(job.message);return;}
      this.busy=true;this.show(job.message);this.timer=setTimeout(()=>this.poll(id),1000);
    }catch(error){this.busy=false;this.show(`读取生成结果失败：${error.message}`);}
  }
  ready(){return this.valid()&&!this.busy&&!this.dirty&&this.maskTask.confirmedRevision===this.document.revision&&!!this.results[0];}
  output(){
    if(!this.ready())return {kind:'video-source',hudState:this.busy?'running':'idle',message:this.message};
    const r=this.results[0];return {kind:'video-source',hudState:'ready',originalFps:r.fps,resolution:{w:r.width,h:r.height},videoWidth:r.width,videoHeight:r.height,duration:r.duration,audio:{hasAudio:r.hasAudio},
      processedAsset:{id:`${this.maskTask.exportId}-dynamic`,url:r.url,filename:r.filename},targetFps:null,fpsConvertMode:'none',
      maskModel:{...this.document.modelBase,sourceSha256:this.document.source.sha256,manualCorrections:!!r.manualCorrections,manualCorrectionCount:r.manualCorrectionCount||0,revision:this.document.revision}};
  }
  downloads(){if(!this.ready())return [];const r=this.results[0];return [{url:r.downloadUrl,label:'下载动态跟随Mask遮罩视频'}];}
  async cancel(){++this.generation;const id=this.busy?this.maskTask.exportId:null;clearTimeout(this.timer);this.busy=false;this.maskTask.exportId=null;this.results=[];if(id)await localRequest(`/api/ui-mask/jobs/${id}/cancel`,post({})).catch(()=>{});this.show('生成已取消，手动草稿保留');}
  dispose(){++this.generation;this.editor?.close();this.flushDocument().catch(()=>{});this.closed=true;clearTimeout(this.timer);clearTimeout(this.saveTimer);}
}
