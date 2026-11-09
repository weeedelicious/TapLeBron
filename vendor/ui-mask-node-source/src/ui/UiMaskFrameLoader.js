// Small, job-local image cache; a decoded element is mounted directly.
export class UiMaskFrameLoader {
  constructor({makeImage=()=>new Image(),timeoutMs=10000,limit=8}={}){this.makeImage=makeImage;this.timeoutMs=timeoutMs;this.limit=limit;this.cache=new Map();this.pending=new Set();}
  load(id,kind,frame){
    const key=`${id}/${kind}/${frame}`;
    if(this.cache.has(key))return this.cache.get(key);
    const image=this.makeImage();this.pending.add(image);
    let timer;
    const promise=Promise.race([
      Promise.resolve().then(()=>{image.src=`/api/ui-mask/jobs/${id}/frames/${kind}/${String(frame).padStart(6,'0')}.png`;return image.decode();}),
      new Promise((_,reject)=>{timer=setTimeout(()=>{image.src='';reject(new Error('图片加载超过10秒，请重试当前帧'));},this.timeoutMs);})
    ]).then(()=>image).catch(error=>{if(this.cache.get(key)===promise)this.cache.delete(key);throw error;}).finally(()=>{clearTimeout(timer);this.pending.delete(image);});
    this.cache.set(key,promise);
    while(this.cache.size>this.limit)this.cache.delete(this.cache.keys().next().value);
    return promise;
  }
  async frame(id,frame,includeMask=false){
    return Promise.all((includeMask?['source','covered','repair']:['source','covered']).map(async kind=>[kind,await this.load(id,kind,frame)]));
  }
  clear(){for(const image of this.pending)image.src='';this.pending.clear();this.cache.clear();}
}
