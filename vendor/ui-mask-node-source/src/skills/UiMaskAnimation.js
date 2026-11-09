// Scalar channels use source frame numbers. Bezier handles are relative
// [frames, value] offsets, so equal endpoint values can still have a curve.
export const MASK_PROPERTIES = ['x','y','width','height','angle'];
export const PROPERTY_NAMES = {x:'位置 X',y:'位置 Y',width:'宽度',height:'高度',angle:'旋转'};
export const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
export function poseValues(p){return {x:p.box[0],y:p.box[1],width:p.box[2]-p.box[0],height:p.box[3]-p.box[1],angle:p.angle||0};}
export function propertyLimit(p,v){return p==='angle'?clamp(v,-36000,36000):clamp(v,p==='width'||p==='height'?.0001:0,1);}
export function segmentControls(a,b){
  const d=b.frame-a.frame,delta=b.value-a.value;
  const out=a.out||[d/3,delta/3],incoming=b.in||[-d/3,-delta/3];
  let x1=clamp(out[0],0,d),x2=clamp(-incoming[0],0,d);
  // Scale both handle vectors together when their time extents overlap.
  const scale=x1+x2>d?d/(x1+x2):1;
  const s1=out[0]===0?1:x1/out[0]*scale,s2=incoming[0]===0?1:-x2/incoming[0]*scale;
  return [[a.frame,a.value],[a.frame+x1*scale,a.value+out[1]*s1],[b.frame-x2*scale,b.value+incoming[1]*s2],[b.frame,b.value]];
}
const cubic=(a,b,c,d,t)=>{const s=1-t;return s*s*s*a+3*s*s*t*b+3*s*t*t*c+t*t*t*d;};
export function scalarAt(channel,frame,ranges){
  const keys=channel.keys;if(!keys.length)return channel.value;
  const range=ranges?.find(([a,b])=>frame>=a&&frame<b);
  let rows=range?keys.filter(k=>k.frame>=range[0]&&k.frame<range[1]):keys;
  if(!rows.length)return (keys.filter(k=>k.frame<=frame).at(-1)||keys[0]).value;
  let lo=0,hi=rows.length-1;
  if(frame<=rows[0].frame)return rows[0].value;
  if(frame>=rows[hi].frame)return rows[hi].value;
  while(hi-lo>1){const m=(lo+hi)>>1;if(rows[m].frame<=frame)lo=m;else hi=m;}
  const a=rows[lo],b=rows[hi];
  if(a.interpolation==='hold')return a.value;
  if(a.interpolation!=='bezier')return a.value+(b.value-a.value)*(frame-a.frame)/(b.frame-a.frame);
  const c=segmentControls(a,b);let left=0,right=1;
  for(let i=0;i<42;i++){const u=(left+right)/2;if(cubic(...c.map(p=>p[0]),u)<frame)left=u;else right=u;}
  return cubic(...c.map(p=>p[1]),(left+right)/2);
}
export function channelPose(track,frame){
  const c=track.animation.channels,v=Object.fromEntries(MASK_PROPERTIES.map(p=>[p,propertyLimit(p,scalarAt(c[p],frame,track.ranges))]));
  const x=clamp(v.x,0,1-v.width),y=clamp(v.y,0,1-v.height);
  return {box:[x,y,x+v.width,y+v.height],angle:v.angle};
}
export function channelsFromAbsolute(track){
  const channels={};
  for(const p of MASK_PROPERTIES){
    const rows=track.keys.map(k=>({frame:k.frame,value:poseValues(k)[p],interpolation:track.interpolation||'linear'}));
    // Retain constant keys too: interval-local behavior must not change on migration.
    channels[p]={value:rows[0].value,keys:rows};
  }
  return {version:1,channels};
}
export function setChannelKey(track,p,frame,value,{seed=true}={}){
  const c=track.animation.channels[p];value=propertyLimit(p,value);
  if(!Number.isInteger(frame)||!Number.isFinite(value))throw new Error('关键帧数值无效');
  if(!c.keys.length&&seed){const start=track.ranges.find(([a,b])=>frame>=a&&frame<b)?.[0];if(start!=null&&start<frame)c.keys.push({frame:start,value:c.value,interpolation:'linear'});}
  const old=c.keys.find(k=>k.frame===frame);
  if(old)old.value=value;
  else{
    const a=c.keys.filter(k=>k.frame<frame).at(-1),b=c.keys.find(k=>k.frame>frame),key={frame,value,interpolation:a?.interpolation||'linear'};
    if(a&&b&&a.interpolation==='bezier'&&track.ranges.some(([s,end])=>a.frame>=s&&b.frame<end)){
      // De Casteljau subdivision preserves the curve when inserting a key at
      // its evaluated value, including equal-value endpoint excursions.
      const points=segmentControls(a,b);let lo=0,hi=1;
      for(let i=0;i<42;i++){const u=(lo+hi)/2;if(cubic(...points.map(p=>p[0]),u)<frame)lo=u;else hi=u;}
      const u=(lo+hi)/2,mix=(x,y)=>x.map((v,i)=>v+(y[i]-v)*u),offset=(x,y)=>x.map((v,i)=>v-y[i]);
      const ab=mix(points[0],points[1]),bc=mix(points[1],points[2]),cd=mix(points[2],points[3]),left=mix(ab,bc),right=mix(bc,cd),middle=mix(left,right);
      a.out=offset(ab,points[0]);b.in=offset(cd,points[3]);key.in=offset(left,middle);key.out=offset(right,middle);
    }
    c.keys.push(key);
  }
  c.keys.sort((a,b)=>a.frame-b.frame);track.manualEdited=true;
}
export function setAnimatedPose(track,frame,pose){
  const old=poseValues(channelPose(track,frame)),next=poseValues(pose);
  for(const p of MASK_PROPERTIES)if(Math.abs(old[p]-next[p])>1e-9){const c=track.animation.channels[p];if(c.keys.length)setChannelKey(track,p,frame,next[p]);else c.value=propertyLimit(p,next[p]);}
}
export function toggleChannel(track,p,frame,on){
  const c=track.animation.channels[p],value=scalarAt(c,frame,track.ranges);
  if(on){if(!c.keys.length)setChannelKey(track,p,frame,value);}
  else{c.value=propertyLimit(p,value);c.keys=[];}
}
export function deleteChannelKey(track,p,frame){
  const c=track.animation.channels[p],value=scalarAt(c,frame,track.ranges);
  c.keys=c.keys.filter(k=>k.frame!==frame);if(!c.keys.length)c.value=propertyLimit(p,value);
}
export function moveChannelKey(track,p,from,to,frames,value){
  if(!Number.isInteger(to)||to<0||to>=frames)throw new Error('关键帧必须位于视频范围内');
  const c=track.animation.channels[p],k=c.keys.find(k=>k.frame===from);if(!k)return;
  if(to!==from&&c.keys.some(k=>k.frame===to))throw new Error('该属性在目标帧已有关键帧');
  k.frame=to;if(value!=null)k.value=propertyLimit(p,value);c.keys.sort((a,b)=>a.frame-b.frame);
}
export function setKeyCurve(track,p,frame,preset){
  const rows=track.animation.channels[p].keys,i=rows.findIndex(k=>k.frame===frame),k=rows[i];if(!k)return;
  if(preset==='hold'){k.interpolation='hold';return;}
  const sameRange=(a,b)=>track.ranges.some(([start,end])=>a.frame>=start&&b.frame<end);
  const segment=(a,b,flatSide)=>{
    if(!a||!b||!sameRange(a,b))return;
    if(preset==='linear'){a.interpolation='linear';return;}
    const d=b.frame-a.frame,delta=b.value-a.value;
    if(a.interpolation!=='bezier'){a.out=[d/3,delta/3];b.in=[-d/3,-delta/3];}
    a.interpolation='bezier';
    if(flatSide==='in')b.in=[-d/3,0];if(flatSide==='out')a.out=[d/3,0];
  };
  if(preset!=='ease-out')segment(rows[i-1],k,['ease','ease-in'].includes(preset)?'in':null);
  if(preset!=='ease-in')segment(k,rows[i+1],['ease','ease-out'].includes(preset)?'out':null);
}
export function validateAnimation(animation,frames){
  if(animation?.version!==1||!animation.channels||Object.keys(animation.channels).length!==MASK_PROPERTIES.length)throw new Error('属性动画版本无效');
  for(const p of MASK_PROPERTIES){
    const c=animation.channels[p],valid=v=>Number.isFinite(v)&&Math.abs(propertyLimit(p,v)-v)<1e-12;
    if(!c||!valid(c.value)||!Array.isArray(c.keys)||c.keys.length>frames)throw new Error('属性动画数值无效');
    for(let i=0;i<c.keys.length;i++){
      const k=c.keys[i];
      if(!Number.isInteger(k.frame)||k.frame<0||k.frame>=frames||(i&&k.frame<=c.keys[i-1].frame)||!valid(k.value)||!['linear','hold','bezier'].includes(k.interpolation))throw new Error('属性关键帧无效');
      for(const side of ['in','out'])if(k[side]!=null){const h=k[side];if(!Array.isArray(h)||h.length!==2||!h.every(Number.isFinite)||Math.abs(h[0])>frames||Math.abs(h[1])>(p==='angle'?72000:4)||(side==='in'?h[0]>0:h[0]<0))throw new Error('曲线手柄无效');}
    }
  }
}
