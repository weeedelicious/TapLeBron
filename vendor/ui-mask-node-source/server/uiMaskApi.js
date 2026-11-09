import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { validateMaskDocument } from '../src/skills/UiMaskDocument.js';
import { maskDetectorConfig, maskPanelConfig, resolveMaskDetector, maskExperimentConfig, maskExperimentModels } from './uiMaskDetector.js';
import { runIdentity, runIsStale, recoveryMode, pipelineVersion } from './uiMaskRunIdentity.js';
import { describeModelOutput, describeModelDraft } from './uiMaskModelOutput.js';
import { draftFramePath } from './uiMaskAssets.js';
import {recordJobTiming,describeJobTiming,saveClientTiming} from './uiMaskTiming.js';
import {cancellationGuard} from './uiMaskCancellation.js';
import {remoteConfig,remoteEligible,remoteHealthy,runRemote} from './uiMaskRemote.js';

const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function atomic(file,data){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data));fs.renameSync(tmp,file);}
async function body(req,max=24*1024**2){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>max)throw new Error('遮罩数据过大，请分段处理');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
function asset(req,res,file,name){
  if(!fs.existsSync(file))return json(res,404,{error:'文件不存在或尚未生成'});
  const size=fs.statSync(file).size, range=req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  let start=0,end=size-1;
  if(req.headers.range&&!range){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
  if(range){if(!range[1])start=Math.max(0,size-Number(range[2]));else start=Number(range[1]);if(range[1]&&range[2])end=Math.min(end,Number(range[2]));}
  if(start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
  const ext=path.extname(file),headers={'Content-Type':ext==='.png'?'image/png':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,'Cache-Control':'no-store'};
  if(name)headers['Content-Disposition']=`attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  if(range)headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  res.writeHead(range?206:200,headers);
  if(req.method==='HEAD')return res.end();
  const stream=fs.createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}
export function uiMaskApi({root=process.cwd(),jobsDirectory=path.join(root,'outputs','ui-mask-jobs'),componentJobsDirectory=jobsDirectory}={}){
  const jobs=jobsDirectory,worker=path.join(root,'server','ui_mask_worker.py');
  const jobRoots=[...new Set([jobs,componentJobsDirectory])];
  const python=process.env.WXHB_UI_PYTHON||path.join(root,'.hud-research','venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const children=new Map(),uploading=new Set(),cancelWorkers=new Map();
  const dir=id=>{if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('任务编号无效');for(const base of jobRoots){const p=path.join(base,id);if(fs.existsSync(path.join(p,'request.json')))return p;}const p=path.join(jobs,id);const legacy=process.env.WXHB_UI_LEGACY_JOBS_DIRECTORY;if(!fs.existsSync(p)&&legacy&&fs.existsSync(path.join(legacy,id,'request.json'))){fs.mkdirSync(jobs,{recursive:true});fs.cpSync(path.join(legacy,id),p,{recursive:true,errorOnExist:true});}if(!fs.existsSync(path.join(p,'request.json')))throw new Error('任务不存在');return p;};
  const remote=remoteConfig();
  // Shotflow：识别 / 导出优先交给 4090 GPU（见 uiMaskRemote.js），连不上才在本机算
  const start=(id)=>{
    const folder=dir(id),request=read(path.join(folder,'request.json'));
    if(!remote||!remoteEligible(request))return startLocal(id);
    const placeholder={remote:true};
    children.set(id,placeholder);
    remoteHealthy(remote).then(ok=>{
      if(!ok){children.delete(id);console.warn('[ui-mask] 4090 GPU 计算节点不可用，改在本机计算',id);return startLocal(id);}
      recordJobTiming(folder,{workerStartedAt:Date.now()});
      const run=runRemote(remote,{id,folder,request});
      cancelWorkers.set(id,run.cancel);
      run.done.finally(()=>{children.delete(id);cancelWorkers.delete(id);recordJobTiming(folder,{workerExitedAt:Date.now()});});
    });
  };
  const startLocal=(id)=>{
    const folder=dir(id),log=fs.openSync(path.join(folder,'worker.log'),'a');
    const request=read(path.join(folder,'request.json'));
    const runtime=request.kind==='experiment'?maskExperimentConfig(root,request.modelVersion).python:request.kind==='analysis'&&request.operation==='detect'&&request.detector==='panel'?maskPanelConfig(root).python:request.kind==='analysis'&&request.operation==='detect'&&request.detector==='trained'?maskDetectorConfig(root).python:python;
    recordJobTiming(folder,{workerStartedAt:Date.now()});
    const child=spawn(runtime,['-u',worker,'--job',folder],{cwd:root,windowsHide:true,stdio:['ignore',log,log]});
    fs.closeSync(log);children.set(id,child);
    cancelWorkers.set(id,cancellationGuard(child,{markCancelled:()=>fs.writeFileSync(path.join(folder,'cancel'),'')}));
    child.on('error',error=>atomic(path.join(folder,'status.json'),{state:'failed',message:error.message}));
    child.on('close',code=>{
      children.delete(id);
      cancelWorkers.delete(id);
      recordJobTiming(folder,{workerExitedAt:Date.now()});
      const status=read(path.join(folder,'status.json'));
      if(!['ready','failed','cancelled'].includes(status.state))atomic(path.join(folder,'status.json'),{state:fs.existsSync(path.join(folder,'cancel'))?'cancelled':'failed',message:`任务已停止（${code}），可重新运行`});
    });
  };
  const create=(request,baseDirectory=jobs)=>{
    if(request.kind==='analysis'&&request.operation==='detect'){request.temporalRecovery=recoveryMode(request.temporalRecovery,request.category,request.detector);if(!Object.hasOwn(request,'provenance'))request.provenance=runIdentity(root,request.detector,request.temporalRecovery);}
    const id=crypto.randomUUID(),folder=path.join(baseDirectory,id);fs.mkdirSync(folder,{recursive:true});
    atomic(path.join(folder,'request.json'),request);atomic(path.join(folder,'status.json'),{state:'waiting',message:'等待视频',progress:0});recordJobTiming(folder,{createdAt:Date.now()});return id;
  };
  const describe=id=>{
    const folder=dir(id),request=read(path.join(folder,'request.json')),status=read(path.join(folder,'status.json'));
    if(['running','waiting'].includes(status.state)&&!children.has(id)&&!uploading.has(id)&&status.state==='running')return {id,kind:request.kind,state:'failed',message:'服务已重启，请重新执行任务'};
    const result={id,kind:request.kind,category:request.category,operation:request.operation,detector:request.detector,modelVersion:request.modelVersion,temporalRecovery:request.temporalRecovery,provenance:request.provenance,...status};
    result.provenance=request.provenance||null;result.stale=runIsStale(root,request);
    if(request.kind==='experiment')result.timing=describeJobTiming(folder,status);
    if(status.state==='ready'&&request.kind==='analysis'){result.document=read(path.join(folder,'document.json'));const info=path.join(folder,'detector-info.json');if(fs.existsSync(info))result.detectorInfo=read(info);}
    if(status.state==='ready'&&request.kind==='experiment')result.experiment=read(path.join(folder,'experiment-result.json'));
    if(status.state==='ready'&&request.kind==='export'){
      result.results=read(path.join(folder,'result.json')).map(r=>({...r,
        url:`/api/ui-mask/jobs/${id}/files/${r.category}/video.mp4`,
        maskUrl:`/api/ui-mask/jobs/${id}/files/${r.category}/mask.mp4?download=1`,
        downloadUrl:`/api/ui-mask/jobs/${id}/files/${r.category}/video.mp4?download=1`,
        referenceUrl:`/api/ui-mask/jobs/${id}/files/${r.category}/reference.png?download=1`}));
      result.revision=request.revision;result.mode=request.mode;
    }
    return result;
  };
  return {name:'ui-mask-api',configureServer(server){
    server.httpServer?.once('close',()=>{for(const stop of cancelWorkers.values())stop();});
    server.middlewares.use('/api/ui-mask',async(req,res)=>{
      try{
        const url=new URL(req.url,'http://localhost'),route=url.pathname;
        if(!['GET','HEAD'].includes(req.method)){
          if(req.headers.origin){let originHost='';try{originHost=new URL(req.headers.origin).host;}catch{return json(res,403,{error:'仅允许当前本机页面操作'});}const requestHost=String(req.headers['x-forwarded-host']||req.headers.host||'');const sameHost=value=>String(value||'').replace(/:\d+$/,'');if(originHost!==requestHost && sameHost(originHost)!==sameHost(requestHost))return json(res,403,{error:'仅允许当前本机页面操作'});}
          if(!/^(application\/json|application\/octet-stream)/.test(req.headers['content-type']||''))return json(res,415,{error:'请求格式无效'});
        }
        const sharedFile=path.join(root,'outputs','ui-mask-shared','canvas.json');
        if(route==='/shared-canvas'&&req.method==='GET'){
          return json(res,200,{canvas:fs.existsSync(sharedFile)?fs.readFileSync(sharedFile,'utf8'):null});
        }
        if(route==='/shared-canvas'&&req.method==='PUT'){
          const input=await body(req);
          if(typeof input.canvas!=='string'||input.canvas.length<2)throw new Error('共享工作流无效');
          JSON.parse(input.canvas);
          fs.mkdirSync(path.dirname(sharedFile),{recursive:true});
          const temporary=sharedFile+'.tmp';
          fs.writeFileSync(temporary,input.canvas);
          fs.renameSync(temporary,sharedFile);
          return json(res,200,{ok:true});
        }
        if(route==='/health'&&req.method==='GET'){
          const model=maskDetectorConfig(root);
          return json(res,200,{ready:fs.existsSync(python),busy:children.size>0,
            trainedAvailable:model.available,modelVersion:model.available?model.version:null,
            updatedAt:model.updatedAt,weightsSha256:model.sha256,pipelineVersion:pipelineVersion(root),requiresManualReview:true});
        }
        if(route==='/experiments/model'&&req.method==='GET'){
          const model=maskExperimentConfig(root,url.searchParams.get('version'));
          return json(res,200,{available:model.available,version:model.version,label:model.label,notice:model.notice,
            maxFrames:model.maxFrames,maxDuration:model.maxDuration,maxWidth:model.maxWidth,maxHeight:model.maxHeight});
        }
        if(route==='/experiments/models'&&req.method==='GET'){
          return json(res,200,{models:maskExperimentModels(root).map(model=>({available:model.available,
            version:model.version,label:model.label,notice:model.notice,applicationDefault:!!model.applicationDefault,maxFrames:model.maxFrames,
            maxDuration:model.maxDuration,maxWidth:model.maxWidth,maxHeight:model.maxHeight}))});
        }
        if(route==='/experiments/recent'&&req.method==='GET'){
          const model=maskExperimentConfig(root,url.searchParams.get('version'));
          const recent=jobRoots.flatMap(base=>fs.existsSync(base)?fs.readdirSync(base).filter(id=>/^[a-f0-9-]{36}$/.test(id)).map(id=>{
            const file=path.join(base,id,'request.json');
            if(!fs.existsSync(file))return null;
            const request=read(file);
            return request.kind==='experiment'&&request.modelVersion===model.version?{id,created:fs.statSync(file).mtimeMs}:null;
          }):[]).filter(Boolean).sort((a,b)=>b.created-a.created)[0];
          return json(res,200,{id:recent?.id||null});
        }
        if(route==='/experiments'&&req.method==='POST'){
          if([...children.keys()].some(id=>read(path.join(dir(id),'request.json')).kind==='experiment'))throw new Error('已有实验检测正在运行，请等待完成或取消');
          const input=await body(req,2048);
          const model=maskExperimentConfig(root,input.modelVersion);
          if(!model.available)throw new Error('实验模型文件或运行环境缺失');
          if(typeof input.filename!=='string'||!input.filename.trim()||input.filename.length>500)throw new Error('视频文件名无效');
          if(input.modelVersion!==model.version)throw new Error('请选择当前可用的实验模型');
          return json(res,201,{id:create({kind:'experiment',filename:input.filename,modelVersion:model.version,weightsSha256:model.sha256,draftOnly:input.draftOnly===true},model.backend==='text-component-association'?componentJobsDirectory:jobs)});
        }
        if(route==='/jobs'&&req.method==='POST'){
          if(!fs.existsSync(python))throw new Error('本机遮罩环境缺失，请恢复 Python、OpenCV 和 FFmpeg 环境');
          const input=await body(req,2048);
          if(typeof input.filename!=='string'||input.filename.length>500)throw new Error('视频文件名无效');
          if(!['static','dynamic'].includes(input.category)||!['manual','detect'].includes(input.operation))throw new Error('请选择处理类别与手工或识别入口');
          const detector=input.operation==='detect'?resolveMaskDetector(root,input.detector):{detector:'manual'};
          return json(res,201,{id:create({kind:'analysis',filename:input.filename,category:input.category,operation:input.operation,temporalRecovery:input.temporalRecovery,...detector})});
        }
        const m=route.match(/^\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/);
        if(!m)return json(res,404,{error:'接口不存在'});
        const [,id,action]=m,folder=dir(id),request=read(path.join(folder,'request.json'));
        if(action==='client-timing'&&req.method==='POST'&&request.kind==='experiment'){
          saveClientTiming(folder,await body(req,4096));return json(res,200,{ok:true});
        }
        if(action==='timing'&&req.method==='GET'&&request.kind==='experiment')return json(res,200,describeJobTiming(folder,read(path.join(folder,'status.json'))));
        if(!action&&req.method==='GET')return json(res,200,describe(id));
        if(action==='model-output'&&req.method==='GET')return json(res,200,describeModelOutput(root,folder,id,request));
        if(action==='model-draft'&&req.method==='GET')return json(res,200,describeModelDraft(root,folder,id,request));
        if(action==='edit-draft'&&req.method==='POST'&&request.kind==='experiment'){
          const base=describeModelDraft(root,folder,id,request);
          const document=validateMaskDocument({version:2,revision:0,source:base.source,tracks:[],modelBase:{jobId:id,modelVersion:base.modelVersion,weightsSha256:base.weightsSha256,repairMarginPx:4}});
          const editId=create({kind:'analysis',filename:base.source.filename,category:'dynamic',operation:'model-edit',modelVersion:base.modelVersion},path.dirname(folder));
          fs.linkSync(path.join(folder,'source.bin'),path.join(dir(editId),'source.bin'));
          atomic(path.join(dir(editId),'document.json'),document);
          atomic(path.join(dir(editId),'status.json'),{state:'ready',message:'模型草稿已载入，可补遮或擦除误遮；确认后生成',progress:100});
          return json(res,201,{id:editId,document});
        }
        if(action==='cancel'&&req.method==='POST'){
          fs.writeFileSync(path.join(folder,'cancel'),'');
          cancelWorkers.get(id)?.();
          if(!children.has(id))atomic(path.join(folder,'status.json'),{state:'cancelled',message:'已取消'});
          return json(res,200,{ok:true});
        }
        if(action==='source'&&req.method==='PUT'&&['analysis','experiment'].includes(request.kind)){
          if(fs.existsSync(path.join(folder,'source.bin'))||uploading.has(id))throw new Error('此任务已有输入视频');
          if(fs.existsSync(path.join(folder,'cancel')))throw new Error('任务已取消，请重新识别');
          if(request.kind==='experiment'&&[...children.keys(),...uploading].some(other=>read(path.join(dir(other),'request.json')).kind==='experiment'))throw new Error('已有实验检测正在运行或上传，请稍后重新开始');
          uploading.add(id);let size=0;recordJobTiming(folder,{uploadStartedAt:Date.now()});
          try{
            const limit=new Transform({transform(chunk,encoding,done){size+=chunk.length;done(size>2*1024**3?new Error('视频超过2GB，请分段处理'):null,chunk);}});
            await pipeline(req,limit,fs.createWriteStream(path.join(folder,'source.upload'),{flags:'wx'}));
            if(!size)throw new Error('视频为空');
            if(fs.existsSync(path.join(folder,'cancel')))throw new Error('上传已取消');
            fs.renameSync(path.join(folder,'source.upload'),path.join(folder,'source.bin'));
            recordJobTiming(folder,{uploadFinishedAt:Date.now(),uploadBytes:size});
            atomic(path.join(folder,'status.json'),{state:'running',message:request.operation==='manual'?'读取视频信息…':'识别本类UI…',progress:0});start(id);
          }finally{uploading.delete(id);}
          return json(res,200,{ok:true});
        }
        if(action==='document'&&req.method==='PUT'&&request.kind==='analysis'){
          if(read(path.join(folder,'status.json')).state!=='ready')throw new Error('请等待识别完成');
          const input=await body(req),previous=read(path.join(folder,'document.json'));
          if(input.baseRevision!==previous.revision)return json(res,409,{error:'遮罩记录已被另一页面修改，请重新打开节点'});
          const document=validateMaskDocument(input.document);
          if(JSON.stringify(document.source)!==JSON.stringify(previous.source))throw new Error('遮罩与输入视频不匹配');
          if(JSON.stringify(document.modelBase)!==JSON.stringify(previous.modelBase))throw new Error('不能改变模型草稿来源');
          const saved={version:document.version,source:previous.source,tracks:document.tracks,revision:previous.revision+1};
          if(previous.modelBase)saved.modelBase=previous.modelBase;
          if(document.nextMaskNumber||previous.nextMaskNumber)saved.nextMaskNumber=Math.max(document.nextMaskNumber||1,previous.nextMaskNumber||1,...document.tracks.map(t=>(t.displayNumber||0)+1));
          atomic(path.join(folder,'document.json'),saved);return json(res,200,{revision:saved.revision});
        }
        if(action==='fork'&&req.method==='POST'&&request.kind==='analysis'){
          if(read(path.join(folder,'status.json')).state!=='ready')throw new Error('原遮罩任务尚未完成，请重新识别');
          const copyId=create({kind:'analysis',filename:request.filename,category:request.category,operation:request.operation,detector:request.detector,modelVersion:request.modelVersion,temporalRecovery:request.temporalRecovery,provenance:request.provenance},path.dirname(folder)),destination=dir(copyId);
          fs.linkSync(path.join(folder,'source.bin'),path.join(destination,'source.bin'));
          const document=read(path.join(folder,'document.json'));document.revision=0;
          atomic(path.join(destination,'document.json'),document);
          atomic(path.join(destination,'status.json'),{state:'ready',message:'遮罩副本已建立，可独立修改',progress:100});
          return json(res,201,{id:copyId});
        }
        if(action==='analyze'&&req.method==='POST'&&request.kind==='analysis'){
          if(read(path.join(folder,'status.json')).state!=='ready')throw new Error('请等待视频准备完成');
          const input=await body(req,4096),document=read(path.join(folder,'document.json'));
          if(document.modelBase)throw new Error('模型修正草稿不能被旧辅助识别覆盖，请在模型检测入口新建草稿');
          if(!['static','dynamic'].includes(input.category))throw new Error('请选择识别类别');
          if(input.revision!==document.revision)return json(res,409,{error:'遮罩已修改，请保存后重试'});
          const detector=resolveMaskDetector(root,input.detector);
          const copyId=create({kind:'analysis',filename:request.filename,category:input.category,operation:'detect',temporalRecovery:input.temporalRecovery,...detector},path.dirname(folder)),destination=dir(copyId);
          fs.linkSync(path.join(folder,'source.bin'),path.join(destination,'source.bin'));
          atomic(path.join(destination,'initial-document.json'),document);
          atomic(path.join(destination,'status.json'),{state:'running',message:'识别本类UI，保留人工修改…',progress:0});start(copyId);
          return json(res,201,{id:copyId});
        }
        if(action==='export'&&req.method==='POST'&&request.kind==='analysis'){
          if(runIsStale(root,request))return json(res,409,{error:'旧识别任务与当前算法或权重不匹配，请重新辅助识别；手动修改保留'});
          const input=await body(req,4096),document=read(path.join(folder,'document.json'));
          if(input.confirmed!==true||!['follow','trail'].includes(input.mode))throw new Error('请确认遮罩范围并选择覆盖方式');
          const coverColor=['black','red','green','blue'].includes(input.coverColor)?input.coverColor:'black';
          if(!['static','dynamic'].includes(input.category))throw new Error('请选择一个输出类别');
          if(input.revision!==document.revision)return json(res,409,{error:'遮罩已修改，请重新确认当前范围'});
          validateMaskDocument(document);
          if(document.modelBase&&(input.category!=='dynamic'||input.mode!=='follow'))throw new Error('模型草稿按当前帧修正输出，不合并静态遮罩或拖尾');
          if(!document.modelBase&&!document.tracks.some(t=>t.kind===input.category&&t.enabled&&t.ranges.length))throw new Error('当前类别没有启用的遮罩，请手画或识别本类UI');
          const exportId=create({kind:'export',parent:id,detector:request.detector,provenance:request.provenance,category:input.category,mode:input.category==='static'?'follow':input.mode,revision:document.revision,coverColor,...(document.modelBase?{modelBase:document.modelBase}:{})},path.dirname(folder));
          atomic(path.join(dir(exportId),'document.json'),document);
          atomic(path.join(dir(exportId),'status.json'),{state:'running',message:`生成${{black:'黑色',red:'红色',green:'绿色',blue:'蓝色'}[coverColor]} Mask 视频…`,progress:0});start(exportId);
          return json(res,201,{id:exportId});
        }
        const file=action?.match(/^files\/(static|dynamic)\/(video\.mp4|mask\.mp4|reference\.png)$/);
        if(file&&['GET','HEAD'].includes(req.method)&&request.kind==='export'){
          if(read(path.join(folder,'status.json')).state!=='ready')throw new Error('输出尚未完成');
          const r=read(path.join(folder,'result.json')).find(r=>r.category===file[1]);
          if(!r)throw new Error('没有此类别的输出');
          const filename=file[2]==='video.mp4'?r.filename:r.filename.replace(/\.mp4$/i,file[2]==='mask.mp4'?'-纯遮罩.mp4':'-配套首帧.png');
          return asset(req,res,path.join(folder,file[1],file[2]),url.searchParams.has('download')?filename:null);
        }
        if(request.kind==='experiment'&&['GET','HEAD'].includes(req.method)){
          if(read(path.join(folder,'status.json')).state!=='ready')throw new Error('实验输出尚未完成');
          const frame=action?.match(/^frames\/(source|raw|repair|covered)\/(\d{6})\.png$/);
          if(frame){
            const info=read(path.join(folder,'experiment-result.json'));
            if(Number(frame[2])>=info.source.frames)return json(res,404,{error:'帧号超出范围'});
            return asset(req,res,draftFramePath(folder,frame[1],Number(frame[2]),info.frameLayout));
          }
          const video=action?.match(/^experiment-files\/(video|mask)\.mp4$/);
          if(video)return asset(req,res,path.join(folder,'dynamic',video[1]+'.mp4'),url.searchParams.has('download')?`实验-${video[1]==='mask'?'纯遮罩':'Mask视频'}.mp4`:null);
        }
        if(action==='source'&&['GET','HEAD'].includes(req.method)&&['analysis','experiment'].includes(request.kind))return asset(req,res,path.join(folder,'source.bin'));
        return json(res,404,{error:'接口不存在'});
      }catch(error){if(!res.headersSent)json(res,400,{error:error.message});else res.destroy();}
    });
  }};
}
