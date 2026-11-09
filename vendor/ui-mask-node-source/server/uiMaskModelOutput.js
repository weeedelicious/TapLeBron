import fs from 'node:fs';
import path from 'node:path';
import { maskExperimentConfig } from './uiMaskDetector.js';

export function describeModelDraft(root, folder, id, request) {
  const read=name=>JSON.parse(fs.readFileSync(path.join(folder,name),'utf8'));
  if(request.kind!=='experiment'||read('status.json').state!=='ready')throw new Error('模型检测尚未完成');
  const info=read('experiment-result.json'),config=maskExperimentConfig(root,request.modelVersion);
  if(info.modelVersion!==request.modelVersion||info.weightsSha256!==request.weightsSha256||info.weightsSha256!==config.sha256
    ||info.referenceMasksUsed!==false||info.trainingInvoked!==false||info.repairMarginPx!==4)throw new Error('模型草稿来源不一致');
  const source=info.source;
  if(!source||!Array.isArray(info.frames)||info.frames.length!==source.frames)throw new Error('模型草稿帧序列不完整');
  return {id,source,modelVersion:info.modelVersion,weightsSha256:info.weightsSha256,modelLabel:config.label,repairMarginPx:4};
}

// Completed inference assets stay immutable. No re-encoding or contour conversion.
export function describeModelOutput(root, folder, id, request) {
  const read = name => JSON.parse(fs.readFileSync(path.join(folder,name),'utf8'));
  if(request.kind!=='experiment'||read('status.json').state!=='ready')throw new Error('模型检测尚未完成');
  const info=read('experiment-result.json'),config=maskExperimentConfig(root,request.modelVersion);
  if(info.modelVersion!==request.modelVersion||info.weightsSha256!==request.weightsSha256||info.weightsSha256!==config.sha256)
    throw new Error('模型输出与登记权重不一致，请重新检测');
  const source=info.source,output=info.export;
  if(!/^[a-f0-9]{64}$/.test(source?.sha256)||!Number.isInteger(source.frames)||source.frames<1
    ||!Number.isFinite(source.duration)||source.duration<=0||!Number.isInteger(source.width)||!Number.isInteger(source.height)
    ||source.frames!==output?.frames||source.width!==output.width||source.height!==output.height
    ||Math.abs(source.duration-output.duration)>0.00001||!Number.isFinite(output.fps)||output.fps<=0
    ||info.repairMarginPx!==4||info.encodingExtraMarginPx!==0||output.edgeGuardPixels!==0||output.exactRepairMask!==true
    ||info.referenceMasksUsed!==false||info.trainingInvoked!==false)
    throw new Error('模型输出的时间轴或修复遮罩记录不完整');
  for(const name of ['video.mp4','mask.mp4']){
    const file=path.join(folder,'dynamic',name);
    if(!fs.existsSync(file)||fs.statSync(file).size===0)throw new Error('模型输出文件缺失，请重新检测');
  }
  const prefix=`/api/ui-mask/jobs/${id}`;
  const asset=(kind,hasAudio)=>({id:`${id}-${kind}`,url:`${prefix}/experiment-files/${kind}.mp4`,
    filename:`模型-${kind==='mask'?'纯遮罩':'Mask视频'}.mp4`,hasAudio});
  return {id,modelVersion:info.modelVersion,modelLabel:config.label,weightsSha256:info.weightsSha256,
    source:{sha256:source.sha256,width:source.width,height:source.height,frames:source.frames,duration:source.duration,fps:output.fps},
    repairMarginPx:4,encodingExtraMarginPx:0,video:asset('video',!!output.hasAudio),mask:asset('mask',false),
    referenceUrl:`${prefix}/frames/covered/000000.png`,notice:config.notice};
}
