import { clamp, scalarAt, setChannelKey, moveChannelKey } from './UiMaskAnimation.js';

// Paths live in the unrotated mask box, independently of position/rotation.
// Every vertex has relative cubic handles; a zero handle is a straight corner.
export const PATH_COORDINATE_LIMIT = 1e6;
export const vertex = (x,y) => ({point:[x,y],in:[0,0],out:[0,0]});
export function isRectanglePath(path){return path.length===4&&path.every((v,i)=>v.point.every((n,j)=>Math.abs(n-[[0,0],[1,0],[1,1],[0,1]][i][j])<1e-10)&&!v.in.some(Boolean)&&!v.out.some(Boolean));}
export function initialPath(track){
  const ref=track.samples[0].box;
  return track.polygon ? track.polygon.map(([x,y])=>vertex((x-ref[0])/(ref[2]-ref[0]),(y-ref[1])/(ref[3]-ref[1])))
    : [vertex(0,0),vertex(1,0),vertex(1,1),vertex(0,1)];
}
export function ensureAppearance(track){
  track.appearance??={version:1,opacity:{value:1,keys:[]},shape:{value:initialPath(track),keys:[]}};
  return track.appearance;
}
export function pathAt(track,frame){
  if(track.kind==='static'&&track.staticAppearance)return structuredClone(track.staticAppearance.shape);
  const c=track.appearance?.shape;if(!c)return initialPath(track);
  if(track.kind==='static'||!c.keys.length)return structuredClone(c.value);
  const range=track.ranges.find(([a,b])=>frame>=a&&frame<b);
  const rows=range?c.keys.filter(k=>k.frame>=range[0]&&k.frame<range[1]):c.keys;
  if(!rows.length)return structuredClone((c.keys.filter(k=>k.frame<=frame).at(-1)||c.keys[0]).value);
  const a=rows.filter(k=>k.frame<=frame).at(-1)||rows[0],b=rows.find(k=>k.frame>frame);
  if(!b||a.frame>=frame||a.interpolation!=='linear'||a.value.length!==b.value.length)return structuredClone(a.value);
  const u=(frame-a.frame)/(b.frame-a.frame);
  return a.value.map((v,i)=>Object.fromEntries(['point','in','out'].map(p=>[p,v[p].map((x,j)=>x+(b.value[i][p][j]-x)*u)])));
}
export function opacityAt(track,frame){
  if(track.kind==='static'&&track.staticAppearance)return track.staticAppearance.opacity;
  const c=track.appearance?.opacity;
  return c?clamp(track.kind==='static'?c.value:scalarAt(c,frame,track.ranges),0,1):1;
}
export function appearanceChannel(track,p){return ensureAppearance(track)[p];}
function proxy(track){return {animation:{channels:{opacity:ensureAppearance(track).opacity}},ranges:track.ranges};}
export function setAppearanceKey(track,p,frame,value){
  const c=ensureAppearance(track)[p];
  if(p==='opacity'){setChannelKey(proxy(track),'opacity',frame,value,{seed:false});return;}
  const old=c.keys.find(k=>k.frame===frame),before=c.keys.filter(k=>k.frame<frame).at(-1);
  if(old)old.value=structuredClone(value);
  else c.keys.push({frame,value:structuredClone(value),interpolation:before?.interpolation||'hold'});
  c.keys.sort((a,b)=>a.frame-b.frame);
  // A new topology is a discrete shape replacement, never an accidental morph.
  for(let i=0;i<c.keys.length-1;i++)if(c.keys[i].value.length!==c.keys[i+1].value.length)c.keys[i].interpolation='hold';
}
export function setAppearanceValue(track,p,frame,value){
  if(track.kind==='static'){
    track.staticAppearance??={shape:pathAt(track,frame),opacity:opacityAt(track,frame)};
    track.staticAppearance[p]=structuredClone(value);return;
  }
  const c=ensureAppearance(track)[p];
  if(p==='shape'){
    // The first curve edit keeps the old shape at the clip start, then morphs to this frame.
    if(!c.keys.length){
      const start=track.ranges.find(([a,b])=>frame>=a&&frame<b)?.[0];
      if(start!=null&&start<frame)c.keys.push({frame:start,value:structuredClone(c.value),interpolation:'linear'});
    }
    setAppearanceKey(track,p,frame,value);
    const keys=c.keys,i=keys.findIndex(k=>k.frame===frame);
    if(i>0)keys[i-1].interpolation=keys[i-1].value.length===keys[i].value.length?'linear':'hold';
    if(i>=0&&keys[i+1])keys[i].interpolation=keys[i].value.length===keys[i+1].value.length?'linear':'hold';
    return;
  }
  if(c.keys.length)setAppearanceKey(track,p,frame,value);else c.value=structuredClone(value);
}
export function deleteAppearanceKey(track,p,frame){
  const c=ensureAppearance(track)[p],value=p==='shape'?pathAt(track,frame):opacityAt(track,frame);
  c.keys=c.keys.filter(k=>k.frame!==frame);if(!c.keys.length)c.value=structuredClone(value);
}
export function moveAppearanceKey(track,p,from,to,frames,value){
  if(p==='opacity'){moveChannelKey(proxy(track),p,from,to,frames,value);return;}
  if(!Number.isInteger(to)||to<0||to>=frames)throw new Error('关键帧必须位于视频范围内');
  const c=ensureAppearance(track).shape,k=c.keys.find(k=>k.frame===from);if(!k)return;
  if(to!==from&&c.keys.some(k=>k.frame===to))throw new Error('该属性在目标帧已有关键帧');
  k.frame=to;c.keys.sort((a,b)=>a.frame-b.frame);
  for(let i=0;i<c.keys.length-1;i++)if(c.keys[i].value.length!==c.keys[i+1].value.length)c.keys[i].interpolation='hold';
}
export function flattenPath(path,steps=24){
  const points=[];
  for(let i=0;i<path.length;i++){
    const a=path[i],b=path[(i+1)%path.length],curved=a.out.some(Boolean)||b.in.some(Boolean),n=curved?steps:1;
    for(let j=0;j<n;j++){const t=j/n,s=1-t;points.push([0,1].map(d=>s*s*s*a.point[d]+3*s*s*t*(a.point[d]+a.out[d])+3*s*t*t*(b.point[d]+b.in[d])+t*t*t*b.point[d]));}
  }
  return points;
}
export function validPath(path){return Array.isArray(path)&&path.length>=3&&path.length<=4096&&path.every(v=>v&&['point','in','out'].every(p=>Array.isArray(v[p])&&v[p].length===2&&v[p].every(n=>Number.isFinite(n)&&Math.abs(n)<=PATH_COORDINATE_LIMIT)));}
export function validateAppearance(track,frames){
  const a=track.appearance;
  if(a){
    if(a.version!==1||!a.opacity||!a.shape)throw new Error('遮罩外观版本无效');
    const c=a.opacity;if(!Number.isFinite(c.value)||c.value<0||c.value>1||!Array.isArray(c.keys)||c.keys.length>frames)throw new Error('不透明度无效');
    for(let i=0;i<c.keys.length;i++){const k=c.keys[i];if(!Number.isInteger(k.frame)||k.frame<0||k.frame>=frames||(i&&k.frame<=c.keys[i-1].frame)||!Number.isFinite(k.value)||k.value<0||k.value>1||!['linear','hold','bezier'].includes(k.interpolation))throw new Error('不透明度关键帧无效');for(const side of ['in','out'])if(k[side]!=null&&(!Array.isArray(k[side])||k[side].length!==2||!k[side].every(Number.isFinite)||Math.abs(k[side][0])>frames||Math.abs(k[side][1])>4||(side==='in'?k[side][0]>0:k[side][0]<0)))throw new Error('不透明度曲线手柄无效');}
    if(!validPath(a.shape.value)||!Array.isArray(a.shape.keys)||a.shape.keys.length>frames)throw new Error('遮罩路径无效');
    for(let i=0;i<a.shape.keys.length;i++){const k=a.shape.keys[i],next=a.shape.keys[i+1];if(!Number.isInteger(k.frame)||k.frame<0||k.frame>=frames||(i&&k.frame<=a.shape.keys[i-1].frame)||!validPath(k.value)||!['linear','hold'].includes(k.interpolation)||(k.interpolation==='linear'&&next&&k.value.length!==next.value.length))throw new Error('形状关键帧无效；不同点数请使用保持换形');}
  }
  if(track.staticAppearance&&(!validPath(track.staticAppearance.shape)||!Number.isFinite(track.staticAppearance.opacity)||track.staticAppearance.opacity<0||track.staticAppearance.opacity>1))throw new Error('静态遮罩外观无效');
}

export function assignMaskNumbers(doc){
  let next=Math.max(doc.nextMaskNumber||1,...doc.tracks.map(t=>(t.displayNumber||0)+1));const used=new Set();
  for(const t of doc.tracks){if(!Number.isSafeInteger(t.displayNumber)||t.displayNumber<1||used.has(t.displayNumber))t.displayNumber=next++;used.add(t.displayNumber);}
  doc.nextMaskNumber=next;
}
export const maskDisplayId=t=>t?`M${String(t.displayNumber||1).padStart(3,'0')}`:'—';
