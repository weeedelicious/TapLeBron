import { localRequest,videoSourceFile,videoSourceUrl } from '../utils/LocalVideo.js';
import { sourceIdentity } from './UiMaskDocument.js';
import { UiMaskModelEdit } from './UiMaskModelEdit.js';

const inputToken=source=>source?.processedAsset?.url||source?.sourceFile||source?.source?.sourceFile||videoSourceUrl(source);
const available=source=>source&&!source.targetFps&&(!source.hudState||source.hudState==='ready')&&inputToken(source);
const sha256=async file=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');

// Owns source binding and completed model assets, separate from editable tracks.
export class UiMaskModelOutput {
  constructor(node){this.node=node;this.state='idle';this.message='检测载入草稿 → 手动修正 → 确认生成 Mask 视频';this.generation=0;}
  changed(){this.node.persist();this.node.propagate();this.node.refresh();}
  matches(){const source=this.node.source();return !!available(source)&&sourceIdentity(source)===this.node.modelMaskTask?.sourceKey&&inputToken(source)===this.verifiedInput;}
  draftReady(){return this.state==='ready'&&!!this.result&&this.matches();}
  ready(){return this.draftReady()&&!!this.editSession?.ready();}
  invalidate(message){++this.generation;this.editSession?.dispose();this.editSession=null;this.result=null;this.verifiedInput=null;this.node.modelMaskTask=null;this.restoreAttempt=null;this.state='idle';this.message=message;this.changed();}
  checkSource(){
    if(this.result&&!this.matches())this.invalidate('输入视频已改变，请重新检测并采用模型结果');
  }
  async bind(id,{restore=false}={}){
    if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('模型任务编号无效');
    const node=this.node,source=node.source();
    if(!available(source))throw new Error('请连接已就绪的原视频，再采用模型结果');
    const key=sourceIdentity(source),token=inputToken(source),generation=++this.generation;
    const saved=(restore||node.modelMaskTask?.id===id)?node.modelMaskTask:null;
    this.state='checking';this.result=null;this.message='正在核对模型结果与节点输入视频…';this.changed();
    try{
      const result=await localRequest(`/api/ui-mask/jobs/${id}/model-draft`);
      if(saved&&(saved.sourceSha256!==result.source.sha256||saved.modelVersion!==result.modelVersion||saved.weightsSha256!==result.weightsSha256))
        throw new Error('保存的模型结果版本不一致，请重新采用结果');
      if(node.disposed||generation!==this.generation)return false;
      if(!available(node.source())||sourceIdentity(node.source())!==key||inputToken(node.source())!==token)
        throw new Error('核对期间输入视频已改变，请重新检测');
      const file=await videoSourceFile(source);
      if(!file||await sha256(file)!==result.source.sha256)throw new Error('检测结果属于另一段视频；请运行当前节点输入视频后再采用');
      if(node.disposed||generation!==this.generation)return false;
      if(!available(node.source())||sourceIdentity(node.source())!==key||inputToken(node.source())!==token)
        throw new Error('核对期间输入视频已改变，请重新检测');
      await this.editSession?.flushDocument();
      let edit=saved?.edit;
      if(edit?.forkOnEdit){const fork=await localRequest(`/api/ui-mask/jobs/${edit.id}/fork`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});edit={id:fork.id};}
      const draft=edit?await localRequest(`/api/ui-mask/jobs/${edit.id}`):await localRequest(`/api/ui-mask/jobs/${id}/edit-draft`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      if(node.disposed||generation!==this.generation)return false;
      if(inputToken(node.source())!==token||sourceIdentity(node.source())!==key)throw new Error('核对期间输入视频已改变，请重新检测');
      if(draft.document?.modelBase?.jobId!==id||draft.document.source.sha256!==result.source.sha256||draft.document.modelBase.weightsSha256!==result.weightsSha256)throw new Error('修正草稿与模型来源不一致');
      this.editSession?.dispose();
      node.modelMaskTask={id,sourceKey:key,sourceSha256:result.source.sha256,modelVersion:result.modelVersion,weightsSha256:result.weightsSha256,edit:edit||{id:draft.id}};
      this.result=result;this.verifiedInput=token;this.state='ready';this.restoreAttempt=node.modelMaskTask;
      this.editSession=new UiMaskModelEdit(this,node.modelMaskTask.edit,draft.document);
      this.message=`已载入 ${result.source.frames} 帧草稿，可手动修正；确认后生成视频`;
      if(!restore)node.setParam('outputSource','model');
      await this.editSession.restore();
      this.changed();return true;
    }catch(error){
      if(generation!==this.generation||node.disposed)return false;
      this.state='error';this.message=error.message;this.result=null;this.verifiedInput=null;this.changed();throw error;
    }
  }
  restore(){
    const task=this.node.modelMaskTask;
    if(!task||this.state==='checking'||this.result||this.restoreAttempt===task||!available(this.node.source()))return;
    this.restoreAttempt=task;
    if(task.sourceKey!==sourceIdentity(this.node.source())){this.invalidate('保存的模型结果与当前输入不同，请重新检测');return;}
    return this.bind(task.id,{restore:true}).catch(()=>{});
  }
  output(kind='video'){
    if(kind!=='video'||!this.draftReady())return {kind:'video-source',hudState:this.state==='checking'?'running':'idle',message:this.message};
    return this.editSession.output();
  }
  downloads(){return this.editSession?.downloads()||[];}
  dispose(){++this.generation;this.editSession?.dispose();this.result=null;this.verifiedInput=null;}
}
