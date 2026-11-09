import { composeModelPixels } from '../skills/UiMaskModelPixels.js';
import { opacityAt } from '../skills/UiMaskAppearance.js';

// Optional raster layer for the existing rectangle/pen/keyframe editor.
export class UiMaskModelLayer {
  constructor(editor){
    this.editor=editor;this.cache=new Map();this.pending=new Set();this.operation='add';
    const e=editor,s=e.node.document.source;
    this.scratch=document.createElement('canvas');this.scratch.width=s.width;this.scratch.height=s.height;this.ctx=this.scratch.getContext('2d',{willReadFrequently:true});
    this.layer=document.createElement('canvas');this.layer.width=s.width;this.layer.height=s.height;
    const tools=document.createElement('label');tools.title='新绘制区域的作用';this.brush=document.createElement('select');this.brush.setAttribute('aria-label','新绘制区域的作用');
    this.brush.add(new Option('补遮漏检 UI','add'));this.brush.add(new Option('擦除模型误遮','erase'));tools.append(this.brush);e.$('.ui-mask-toolbar').prepend(tools);this.brush.onchange=()=>{this.operation=this.brush.value;e.status(this.operation==='erase'?'绘制要擦除的模型区域，可设置出现时段和关键帧；不会擦掉手动补遮':'绘制漏掉的 UI，输出时统一留出 4px 安全边');};
    const label=document.createElement('label');label.textContent='修正作用';this.choice=document.createElement('select');this.choice.setAttribute('aria-label','所选区域的修正作用');this.choice.add(new Option('补遮漏检 UI','add'));this.choice.add(new Option('擦除模型误遮','erase'));label.append(this.choice);e.$('[data-panel="transform"]').prepend(label);
    this.choice.onchange=()=>e.edit(()=>{const t=e.track();if(t)t.maskOperation=this.choice.value;});
    e.field('opacity').value=45;
    e.$('.ui-mask-title strong').textContent='模型遮罩 · 手动修正';
    e.$('[data-action="enable"]').textContent='启用全部修正';e.$('[data-action="disable"]').textContent='停用全部修正';
    e.field('category').disabled=true;e.field('category').hidden=true;e.field('kind').closest('label').hidden=true;e.$('[data-view="mode"]').hidden=true;
    for(const b of e.dialog.querySelectorAll('[data-mask-choice="static"],[data-mask-choice="dynamic"]'))b.hidden=true;
    e.$('[data-view="empty"]').textContent='模型遮罩已作为底层载入。选“补遮”或“擦除模型误遮”，使用矩形/钢笔绘制修正范围。';
    for(const note of e.dialog.querySelectorAll('aside .ui-mask-note'))if(note.textContent.includes('原音频'))note.textContent='当前动态阶段单独输出，原音频保留。预览浓度仅用于检查；修正不透明度为 0 时暂停该修正，其余值按实心遮罩处理。';
  }
  decorate(track){track.maskOperation=this.operation;track.label=this.operation==='erase'?'擦除模型误遮':'手动补遮';return track;}
  refresh(){const e=this.editor,t=e.track();this.choice.value=t?.maskOperation||'add';this.choice.disabled=e.node.busy;this.brush.disabled=e.node.busy;e.field('category').disabled=true;e.$('[data-view="mode"]').hidden=true;e.$('[data-view="summary"]').textContent=`模型检测 ${e.node.document.source.frames} 帧 · 已启用手动修正 ${e.visibleTracks().filter(t=>t.enabled&&t.ranges.length).length} 处`;}
  async load(frame){
    if(this.pending.has(frame))return;this.pending.add(frame);
    const e=this.editor;
    e.status(`正在载入第 ${frame+1} 帧模型遮罩…`);
    try{
      const image=new Image();image.src=`/api/ui-mask/jobs/${e.node.document.modelBase.jobId}/frames/raw/${String(frame).padStart(6,'0')}.png`;await image.decode();
      if(e.closed)return;
      this.ctx.clearRect(0,0,this.scratch.width,this.scratch.height);this.ctx.drawImage(image,0,0);
      const pixels=this.ctx.getImageData(0,0,this.scratch.width,this.scratch.height).data,raw=new Uint8Array(pixels.length/4);
      for(let i=0;i<raw.length;i++)raw[i]=pixels[i*4]>0?1:0;
      this.cache.set(frame,raw);while(this.cache.size>8)this.cache.delete(this.cache.keys().next().value);
      if(e.frame===frame){e.draw();e.status('半透明显示仅供检查，生成后为实心 Mask；补遮与擦除都可设置时段');}
    }catch(error){if(!e.closed)e.status(`模型遮罩读取失败：${error.message}`);}
    finally{this.pending.delete(frame);}
  }
  draw(ctx,opacity){
    const e=this.editor,raw=this.cache.get(e.frame),w=this.layer.width,h=this.layer.height;
    if(!raw){this.load(e.frame);return;}
    const signature=`${e.frame}:${JSON.stringify(e.visibleTracks())}`;
    if(this.signature!==signature){
      const raster=operation=>{
        this.ctx.clearRect(0,0,w,h);
        for(const t of e.visibleTracks())if(t.enabled&&(t.maskOperation||'add')===operation&&opacityAt(t,e.frame)>0)e.fillTrack(this.ctx,t,e.frame,'#000');
        const data=this.ctx.getImageData(0,0,w,h).data,result=new Uint8Array(w*h);for(let i=0;i<result.length;i++)result[i]=data[i*4+3]>0?1:0;return result;
      };
      const pixels=composeModelPixels(raw,raster('add'),raster('erase'),w,h),layer=this.layer.getContext('2d'),image=layer.createImageData(w,h);
      for(let i=0;i<pixels.length;i++)image.data[i*4+3]=pixels[i];
      layer.putImageData(image,0,0);this.signature=signature;
    }
    ctx.globalAlpha=opacity;ctx.drawImage(this.layer,0,0);ctx.globalAlpha=1;
  }
}
