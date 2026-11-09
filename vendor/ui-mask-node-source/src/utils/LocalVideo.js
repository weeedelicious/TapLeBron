export async function localRequest(url, options={}) {
  const response=await fetch(url,{cache:'no-store',...options});
  const data=await response.json().catch(()=>{throw new Error('本机服务未就绪，请重启应用服务');});
  if(!response.ok){const e=new Error(data.error||`请求失败（${response.status}）`);e.status=response.status;throw e;}
  return data;
}
export function videoSourceUrl(source) { return source?.processedAsset?.url || source?.video?.src || source?.source?.src || ''; }
export async function videoSourceFile(source,signal) {
  if(source?.hudState && source.hudState!=='ready')throw new Error(source.message||'请先完成上游视频处理');
  if(source?.processedAsset?.url){const r=await fetch(source.processedAsset.url,{signal});if(!r.ok)throw new Error('视频文件读取失败');return new File([await r.blob()],source.processedAsset.filename||'video.mp4',{type:'video/mp4'});}
  return source?.sourceFile || source?.source?.sourceFile || null;
}
