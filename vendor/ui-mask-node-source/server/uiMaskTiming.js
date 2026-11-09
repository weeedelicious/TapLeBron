import fs from 'node:fs';
import path from 'node:path';

const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
function write(file,data){fs.writeFileSync(file+'.tmp',JSON.stringify(data));fs.renameSync(file+'.tmp',file);}
export function recordJobTiming(folder,patch){const file=path.join(folder,'server-timing.json');write(file,{...read(file),...patch});}
export function describeJobTiming(folder,status){
  const saved=read(path.join(folder,'server-timing.json'))||{};
  const readyAt=status.state==='ready'?fs.statSync(path.join(folder,'status.json')).mtimeMs:null;
  return {...saved,readyAt,readyToQuerySeconds:readyAt?Math.max(0,Date.now()-readyAt)/1000:null,createdToReadySeconds:readyAt&&saved.createdAt?(readyAt-saved.createdAt)/1000:null,
    latestClientRun:(read(path.join(folder,'client-timings.json'))||[]).filter(r=>r.mode==='run').at(-1)||null};
}
export function saveClientTiming(folder,input){
  if(!input||!/^[a-f0-9-]{36}$/.test(input.runId)||!['run','restore'].includes(input.mode)||!Number.isSafeInteger(input.sequence)||input.sequence<1||typeof input.completed!=='boolean')throw new Error('页面计时格式无效');
  const result={runId:input.runId,mode:input.mode,sequence:input.sequence,completed:input.completed,receivedAt:Date.now()};
  if(!Number.isFinite(input.totalSeconds))throw new Error('页面总耗时无效');
  for(const key of ['totalSeconds','inputSeconds','allocationSeconds','uploadSeconds','waitSeconds','decodeSeconds','paintSeconds','hiddenSeconds','backendSeconds','resultPickupSeconds']){
    const value=input[key];if(value!=null&&(!Number.isFinite(value)||value<0||value>86400))throw new Error('页面计时数值无效');result[key]=value??null;
  }
  if(!Number.isFinite(input.startedAt)||input.startedAt<0)throw new Error('页面计时起点无效');result.startedAt=input.startedAt;
  const file=path.join(folder,'client-timings.json'),rows=read(file)||[],old=rows.find(r=>r.runId===result.runId);
  if(old&&old.sequence>=result.sequence)return;
  write(file,[...rows.filter(r=>r.runId!==result.runId),result].slice(-8));
}
