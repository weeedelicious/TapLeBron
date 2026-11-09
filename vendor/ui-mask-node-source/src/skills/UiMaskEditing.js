import { ensureTrackChannels, poseAt, setTrackPose } from './UiMaskDocument.js';
import { scalarAt, setChannelKey, deleteChannelKey, propertyLimit, setKeyCurve } from './UiMaskAnimation.js';
import { ensureAppearance, pathAt, opacityAt, setAppearanceKey, setAppearanceValue, deleteAppearanceKey } from './UiMaskAppearance.js';

export const PROPERTY_GROUPS=[{id:'position',name:'位置',members:['x','y']},{id:'rotation',name:'旋转',members:['angle']},{id:'shape',name:'形状',members:['shape','width','height']},{id:'opacity',name:'不透明度',members:['opacity']}];
export const defaultPropertyVisibility=()=>Object.fromEntries(PROPERTY_GROUPS.map(g=>[g.id,true]));
export const checkedProperties=visible=>PROPERTY_GROUPS.filter(g=>visible[g.id]).flatMap(g=>g.members);
export const groupFor=p=>PROPERTY_GROUPS.find(g=>g.members.includes(p))?.id||'position';
export const groupMembers=g=>PROPERTY_GROUPS.find(p=>p.id===g)?.members||[];
export const keyId=r=>`${r.p}:${r.frame}`;
export function channel(track,p){return p==='shape'||p==='opacity'?ensureAppearance(track)[p]:ensureTrackChannels(track)[p];}
export function valueAt(track,p,frame){if(p==='shape')return pathAt(track,frame);if(p==='opacity')return opacityAt(track,frame);if(track.kind==='static'){const {box:b,angle}=poseAt(track,frame);return {x:b[0],y:b[1],width:b[2]-b[0],height:b[3]-b[1],angle}[p];}return scalarAt(channel(track,p),frame,track.ranges);}
export function putKey(track,p,frame,value=valueAt(track,p,frame)){
  if(p==='shape'||p==='opacity')setAppearanceKey(track,p,frame,value);
  else {ensureTrackChannels(track);setChannelKey(track,p,frame,value,{seed:false});}
}
export function setValue(track,p,frame,value){
  if(p==='shape'||p==='opacity'){setAppearanceValue(track,p,frame,value);return;}
  if(track.kind==='static'){
    const pose=poseAt(track,frame),b=pose.box,w=b[2]-b[0],h=b[3]-b[1];value=propertyLimit(p,value);
    if(p==='angle')pose.angle=value;
    if(p==='x'){b[0]=Math.min(value,1-w);b[2]=b[0]+w;}if(p==='y'){b[1]=Math.min(value,1-h);b[3]=b[1]+h;}
    if(p==='width')b[2]=Math.min(1,b[0]+value);if(p==='height')b[3]=Math.min(1,b[1]+value);setTrackPose(track,frame,pose);return;
  }
  const c=channel(track,p);if(c.keys.length)putKey(track,p,frame,value);else c.value=propertyLimit(p,value);
}
export function setGroupAnimation(track,group,frame,on){
  const members=group==='shape'&&on?['shape']:groupMembers(group);
  for(const p of members){const value=valueAt(track,p,frame),c=channel(track,p);if(on){if(!c.keys.length)putKey(track,p,frame,value);}else{c.value=structuredClone(value);c.keys=[];}}
}
export function groupKeys(track,group){
  const map=new Map();for(const p of groupMembers(group))for(const k of channel(track,p).keys){const row=map.get(k.frame)||[];row.push({p,frame:k.frame});map.set(k.frame,row);}
  return [...map].sort((a,b)=>a[0]-b[0]).map(([frame,refs])=>({frame,refs}));
}
export function deleteKeys(track,refs){
  for(const {p,frame} of refs){if(p==='shape'||p==='opacity')deleteAppearanceKey(track,p,frame);else {ensureTrackChannels(track);deleteChannelKey(track,p,frame);}}
}
export function moveKeys(track,refs,delta,frames,valueChanges={}){
  const selected=new Set(refs.map(keyId));
  const rows=refs.map(r=>({p:r.p,old:r.frame,row:structuredClone(channel(track,r.p).keys.find(k=>k.frame===r.frame))})).filter(x=>x.row);
  for(const {p,row} of rows){const to=row.frame+delta;if(!Number.isInteger(to)||to<0||to>=frames)throw new Error('关键帧不能移出片段');if(channel(track,p).keys.some(k=>k.frame===to&&!selected.has(keyId({p,frame:k.frame}))))throw new Error('目标帧已有关键帧，未覆盖');}
  for(const p of new Set(rows.map(x=>x.p)))channel(track,p).keys=channel(track,p).keys.filter(k=>!selected.has(keyId({p,frame:k.frame})));
  for(const {p,old,row} of rows){row.frame+=delta;if(valueChanges[keyId({p,frame:old})]!=null&&p!=='shape')row.value=propertyLimit(p,valueChanges[keyId({p,frame:old})]);channel(track,p).keys.push(row);}
  for(const p of new Set(rows.map(x=>x.p))){const keys=channel(track,p).keys;keys.sort((a,b)=>a.frame-b.frame);if(p==='shape')for(let i=0;i<keys.length-1;i++)if(keys[i].value.length!==keys[i+1].value.length)keys[i].interpolation='hold';}
  return rows.map(x=>({p:x.p,frame:x.row.frame}));
}
export function copyKeys(track,refs){return refs.map(r=>({p:r.p,key:structuredClone(channel(track,r.p).keys.find(k=>k.frame===r.frame))})).filter(r=>r.key);}
export function pasteKeys(track,clipboard,frame,frames){
  if(!clipboard.length)return [];const first=Math.min(...clipboard.map(r=>r.key.frame)),rows=clipboard.map(r=>({p:r.p,key:{...structuredClone(r.key),frame:r.key.frame-first+frame}}));
  for(const {p,key} of rows){if(key.frame<0||key.frame>=frames)throw new Error('粘贴会超出片段');if(channel(track,p).keys.some(k=>k.frame===key.frame))throw new Error('粘贴位置已有关键帧，未覆盖');}
  for(const {p,key} of rows)channel(track,p).keys.push(key);
  for(const p of new Set(rows.map(r=>r.p))){const keys=channel(track,p).keys;keys.sort((a,b)=>a.frame-b.frame);if(p==='shape')for(let i=0;i<keys.length-1;i++)if(keys[i].value.length!==keys[i+1].value.length)keys[i].interpolation='hold';}
  return rows.map(r=>({p:r.p,frame:r.key.frame}));
}
export function curvePreset(track,p,frame,preset){
  if(p==='shape'){const c=channel(track,p),i=c.keys.findIndex(k=>k.frame===frame),k=c.keys[i];if(!k)return;if(preset!=='hold'&&c.keys[i+1]&&k.value.length!==c.keys[i+1].value.length)throw new Error('两帧的路径点数不同，请使用保持换形');k.interpolation=preset==='hold'?'hold':'linear';return;}
  const proxy=p==='opacity'?{animation:{channels:{opacity:channel(track,p)}},ranges:track.ranges}:track;
  if(p!=='opacity')ensureTrackChannels(track);setKeyCurve(proxy,p,frame,preset);
}
