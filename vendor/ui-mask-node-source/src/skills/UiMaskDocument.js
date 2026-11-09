// Normalized geometry and source-frame intervals are shared by the editor and exporter.
import { channelPose, channelsFromAbsolute, setAnimatedPose, validateAnimation } from './UiMaskAnimation.js';
import { pathAt, opacityAt, flattenPath, validateAppearance, ensureAppearance } from './UiMaskAppearance.js';
import { randomUUID } from '../utils/randomUUID.js';
export const MASK_VERSION = 2;
export const cloneMask = value => structuredClone(value);
export function validBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)
    && box.every(v => v >= 0 && v <= 1) && box[2] > box[0] && box[3] > box[1];
}
export function clampBox(box) {
  const x=Math.max(0, Math.min(.9999, box[0])),y=Math.max(0, Math.min(.9999, box[1]));
  return [x,y,Math.max(x+.0001,Math.min(1,box[2])),Math.max(y+.0001,Math.min(1,box[3]))];
}
export function polygonAt(track,box){
  if(!track.polygon)return null;
  const ref=track.samples[0].box;
  return track.polygon.map(p=>p.map((v,i)=>Math.max(0,Math.min(1,box[i]+(v-ref[i])*(box[i+2]-box[i])/(ref[i+2]-ref[i])))));
}
export function validateMaskDocument(doc) {
  const s = doc?.source;
  if (![1,MASK_VERSION].includes(doc?.version) || !s || !/^[a-f0-9]{64}$/.test(s.sha256)
    || ![s.width, s.height, s.frames].every(n => Number.isInteger(n) && n > 0)
    || !Number.isFinite(s.duration) || s.duration <= 0 || !Number.isFinite(s.fps) || s.fps <= 0
    || !Array.isArray(s.times) || s.times.length !== s.frames
    || s.times.some((t, i) => !Number.isFinite(t) || t < 0 || (i && t <= s.times[i-1]))
    || s.duration <= s.times.at(-1)) throw new Error('视频帧序列无效，请重新识别');
  if (!Array.isArray(doc.tracks) || doc.tracks.length > 2000) throw new Error('遮罩数量无效');
  if(doc.modelBase&&(!/^[a-f0-9-]{36}$/.test(doc.modelBase.jobId)||!/^[a-f0-9]{64}$/.test(doc.modelBase.weightsSha256)
    ||typeof doc.modelBase.modelVersion!=='string'||doc.modelBase.repairMarginPx!==4))throw new Error('模型草稿来源无效');
  const ids = new Set(),displayNumbers=new Set();
  if(doc.nextMaskNumber!=null&&(!Number.isSafeInteger(doc.nextMaskNumber)||doc.nextMaskNumber<1))throw new Error('遮罩编号序列无效');
  for (const t of doc.tracks) {
    if (!t || typeof t.id !== 'string' || !/^[\w-]{1,80}$/.test(t.id) || ids.has(t.id)
      || !['static','dynamic'].includes(t.kind) || typeof t.enabled !== 'boolean'
      || typeof t.label !== 'string' || t.label.length > 100 || !Array.isArray(t.ranges)
      || t.ranges.length > s.frames || t.ranges.some((r,i) => !Array.isArray(r) || r.length !== 2
        || !r.every(Number.isInteger) || r[0] < 0 || r[1] > s.frames || r[0] >= r[1]
        || (i && r[0] < t.ranges[i-1][1]))) throw new Error('遮罩名称或出现时段无效');
    ids.add(t.id);
    if(t.maskOperation!=null&&(!doc.modelBase||!['add','erase'].includes(t.maskOperation)))throw new Error('遮罩修正操作无效');
    if(doc.modelBase&&t.kind!=='dynamic')throw new Error('模型草稿仅编辑本阶段动态遮罩');
    validateAppearance(t,s.frames);
    if(t.displayNumber!=null){if(!Number.isSafeInteger(t.displayNumber)||t.displayNumber<1||displayNumbers.has(t.displayNumber))throw new Error('遮罩显示编号无效');displayNumbers.add(t.displayNumber);}
    if(t.animation!=null){if(doc.version!==2||t.motionMode!=='absolute')throw new Error('属性动画需要新版工程格式');validateAnimation(t.animation,s.frames);}
    if (t.motionMode != null && t.motionMode !== 'absolute') throw new Error('遮罩轨迹模式无效');
    if (t.interpolation != null && !['linear','hold'].includes(t.interpolation)) throw new Error('关键帧插值方式无效');
    if (!Array.isArray(t.samples) || !t.samples.length || t.samples.length > s.frames
      || t.samples.some((a,i) => !Number.isInteger(a.frame) || a.frame < 0 || a.frame >= s.frames
        || !validBox(a.box) || (i && a.frame <= t.samples[i-1].frame))) throw new Error('遮罩轨迹无效');
    for (const key of ['keys','overrides']) {
      if (!Array.isArray(t[key]) || t[key].length > s.frames || t[key].some((a,i) =>
        !Number.isInteger(a.frame) || a.frame < 0 || a.frame >= s.frames || !validBox(a.box)
        || (a.angle != null && (!Number.isFinite(a.angle) || Math.abs(a.angle)>36000))
        || (i && a.frame <= t[key][i-1].frame))) throw new Error('遮罩修正帧无效');
    }
    if(t.motionMode==='absolute'&&!t.keys.length)throw new Error('请保留至少一个关键帧');
    if(t.staticPose && (!validBox(t.staticPose.box)||!Number.isFinite(t.staticPose.angle)||Math.abs(t.staticPose.angle)>36000))throw new Error('静态遮罩变换无效');
    if (t.polygon != null && (!Array.isArray(t.polygon) || t.polygon.length < 3 || t.polygon.length > 4096
      || t.polygon.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || v < 0 || v > 1)))) {
      throw new Error('遮罩轮廓无效');
    }
  }
  return doc;
}
export function interpolate(samples, frame) {
  let lo = 0, hi = samples.length-1;
  if (frame <= samples[0].frame) return [...samples[0].box];
  if (frame >= samples[hi].frame) return [...samples[hi].box];
  while (hi-lo > 1) { const m = (lo+hi)>>1; if (samples[m].frame <= frame) lo=m; else hi=m; }
  const a=samples[lo], b=samples[hi], u=(frame-a.frame)/(b.frame-a.frame);
  return a.box.map((v,i)=>v+(b.box[i]-v)*u);
}
export function activeAt(track, frame) { return track.ranges.some(([a,b])=>frame>=a && frame<b); }
export function boxAt(track, frame) {
  if (!activeAt(track, frame)) return null;
  if(track.kind==='static'&&track.staticPose)return [...track.staticPose.box];
  if(track.motionMode==='absolute')return poseAt(track,frame).box;
  const single=track.overrides.find(p=>p.frame===frame);
  if (single) return [...single.box];
  const base=interpolate(track.samples,frame);
  if (!track.keys.length) return base;
  const offsets=track.keys.map(k=>({frame:k.frame,box:k.box.map((v,i)=>v-interpolate(track.samples,k.frame)[i])}));
  const delta=interpolate(offsets,frame);
  return clampBox(base.map((v,i)=>v+delta[i]));
}
export function frameAt(times, time) {
  let lo=0,hi=times.length;
  while(lo<hi){const m=(lo+hi)>>1;if(times[m]<=time+1e-6)lo=m+1;else hi=m;}
  return Math.max(0,lo-1);
}
export function setTrackBox(track, frame, box, scope='key') {
  if (!validBox(box)) throw new Error('遮罩边界无效');
  if(track.motionMode==='absolute'||track.staticPose){setTrackPose(track,frame,{box,angle:poseAt(track,frame).angle});return;}
  const old=boxAt(track,frame) || interpolate(track.samples,frame);
  if (scope==='all' || track.kind==='static') {
    const transform=b=>clampBox(b.map((v,i)=>box[i%2]+(v-old[i%2])*(box[i%2+2]-box[i%2])/(old[i%2+2]-old[i%2])));
    for(const key of ['samples','keys','overrides']) for(const p of track[key]) p.box=transform(p.box);
    if(track.polygon) track.polygon=track.polygon.map(p=>p.map((v,i)=>Math.max(0,Math.min(1,box[i]+(v-old[i])*(box[i+2]-box[i])/(old[i+2]-old[i])))));
  } else {
    const list=scope==='frame'?track.overrides:track.keys;
    if(scope!=='frame' && !list.length && frame>track.ranges[0][0]) {
      const f=track.ranges[0][0]; list.push({frame:f,box:boxAt(track,f)||interpolate(track.samples,f)});
    }
    const i=list.findIndex(p=>p.frame===frame), row={frame,box:[...box]};
    if(i>=0)list[i]=row;else list.push(row);
    list.sort((a,b)=>a.frame-b.frame);
    if(scope!=='frame')track.overrides=track.overrides.filter(p=>p.frame!==frame);
  }
}
export function makeTrack(kind, box, frame, frames) {
  return {id:randomUUID(),label:kind==='static'?'手动静态UI':'手动动态UI',kind,enabled:true,
    origin:'manual',classificationLocked:true,motionMode:'absolute',interpolation:'linear',
    ranges:[[kind==='static'?0:frame,frames]],samples:[{frame:kind==='static'?0:frame,box:[...box]}],
    keys:[{frame:kind==='static'?0:frame,box:[...box],angle:0}],overrides:[],
    ...(kind==='static'?{staticPose:{box:[...box],angle:0}}:{})};
}

// Absolute keys are the only effective motion source after editing. Legacy
// offset corrections remain readable until their first key edit, then bake once.
export function poseAt(track,frame){
  if(track.kind==='static'&&track.staticPose)return structuredClone(track.staticPose);
  if(track.animation)return channelPose(track,frame);
  if(track.motionMode!=='absolute')return {box:boxAt(track,frame)||interpolate(track.samples,frame),angle:0};
  const range=track.ranges.find(([a,b])=>frame>=a&&frame<b);
  let rows=range?track.keys.filter(k=>k.frame>=range[0]&&k.frame<range[1]):track.keys;
  if(!rows.length){const previous=track.keys.filter(k=>k.frame<=frame).at(-1);rows=[previous||track.keys[0]];}
  let lo=0,hi=rows.length-1;
  while(hi-lo>1){const m=(lo+hi)>>1;if(rows[m].frame<=frame)lo=m;else hi=m;}
  let a=rows[lo],b=rows[hi];
  if(frame<=a.frame)b=a;else if(frame>=b.frame)a=b;
  const u=a===b||track.interpolation==='hold'?0:(frame-a.frame)/(b.frame-a.frame);
  return {box:a.box.map((v,i)=>v+(b.box[i]-v)*u),angle:(a.angle||0)+((b.angle||0)-(a.angle||0))*u};
}
export function ensureAbsolute(track){
  if(track.motionMode==='absolute')return;
  const keys=[];
  for(const [start,end] of track.ranges){
    const rows=[];
    for(let frame=start;frame<end;frame++){
      const p={frame,box:boxAt(track,frame),angle:0};
      while(rows.length>=2){
        const a=rows.at(-2),b=rows.at(-1),u=(b.frame-a.frame)/(frame-a.frame);
        if(!b.box.every((v,i)=>Math.abs(v-(a.box[i]+(p.box[i]-a.box[i])*u))<1e-10))break;
        rows.pop();
      }
      rows.push(p);
    }
    keys.push(...rows);
  }
  if(!keys.length)keys.push({frame:track.samples[0].frame,box:[...track.samples[0].box],angle:0});
  track.keys=keys;track.overrides=[];track.motionMode='absolute';track.interpolation='linear';
}
export function setTrackPose(track,frame,pose){
  if(!validBox(pose.box)||!Number.isFinite(pose.angle)||Math.abs(pose.angle)>36000)throw new Error('遮罩变换无效');
  ensureAbsolute(track);
  if(track.kind==='static'){track.staticPose=structuredClone(pose);return;}
  if(track.animation){setAnimatedPose(track,frame,pose);return;}
  const key={frame,box:[...pose.box],angle:pose.angle},index=track.keys.findIndex(k=>k.frame===frame);
  if(index<0)track.keys.push(key);else track.keys[index]=key;
  track.keys.sort((a,b)=>a.frame-b.frame);track.manualEdited=true;
}
export function ensureTrackChannels(track){
  if(!track.animation){ensureAbsolute(track);track.animation=channelsFromAbsolute(track);}
  return track.animation.channels;
}
export function deleteTrackKey(track,frame){
  ensureAbsolute(track);
  if(track.keys.length<=1)throw new Error('请保留一个关键帧；移除整个遮罩请使用右键菜单');
  track.keys=track.keys.filter(k=>k.frame!==frame);
}
export function moveTrackKey(track,from,to,frames){
  ensureAbsolute(track);
  if(!Number.isInteger(to)||to<0||to>=frames)throw new Error('关键帧必须位于视频范围内');
  if(from===to)return;
  if(track.keys.some(k=>k.frame===to))throw new Error('目标帧已有关键帧，请先修改或删除该键');
  const key=track.keys.find(k=>k.frame===from);if(!key)return;
  key.frame=to;track.keys.sort((a,b)=>a.frame-b.frame);
}
export function changeTrackKind(track,kind,frame){
  if(!['static','dynamic'].includes(kind))throw new Error('遮罩类别无效');
  track.classificationLocked=true;track.manualEdited=true;
  if(kind===track.kind)return;
  const pose=poseAt(track,frame);
  // A static pose is a separate view of the object; its motion data is retained.
  if(kind==='static'){const appearance={shape:pathAt(track,frame),opacity:opacityAt(track,frame)};ensureAbsolute(track);track.staticPose=pose;track.staticAppearance=appearance;track.hasDynamicHistory=true;}
  else if(!track.hasDynamicHistory){
    const appearance={shape:pathAt(track,frame),opacity:opacityAt(track,frame)};
    ensureAbsolute(track);track.keys=[{frame,box:[...pose.box],angle:pose.angle}];delete track.animation;
    // A newly animated static mask starts with constant channels. Its first S
    // command must not implicitly seed keys on every other property.
    for(const c of Object.values(ensureTrackChannels(track)))c.keys=[];
    const channels=ensureAppearance(track);
    for(const p of ['shape','opacity'])channels[p]={value:appearance[p],keys:[]};
  }
  track.kind=kind;
}
export function trackPolygon(track,frame,source){
  const box=boxAt(track,frame);if(!box)return null;
  const points=track.appearance||track.staticAppearance?flattenPath(pathAt(track,frame)).map(([x,y])=>[box[0]+x*(box[2]-box[0]),box[1]+y*(box[3]-box[1])]):polygonAt(track,box)||[[box[0],box[1]],[box[2],box[1]],[box[2],box[3]],[box[0],box[3]]];
  const angle=poseAt(track,frame).angle*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const cx=(box[0]+box[2])*source.width/2,cy=(box[1]+box[3])*source.height/2;
  return points.map(([x,y])=>{const dx=x*source.width-cx,dy=y*source.height-cy;return [(cx+dx*c-dy*s)/source.width,(cy+dx*s+dy*c)/source.height];});
}
// Pixel-center scanlines shared with Python for hard, opaque rotated masks.
export function polygonSpans(points,width,height){
  const p=points.map(([x,y])=>[x*width,y*height]),rows=[];
  const first=Math.max(0,Math.ceil(Math.min(...p.map(v=>v[1]))-.5));
  const last=Math.min(height,Math.ceil(Math.max(...p.map(v=>v[1]))-.5));
  for(let y=first;y<last;y++){
    const intersections=[],center=y+.5;
    for(let i=0;i<p.length;i++){
      const a=p[i],b=p[(i+1)%p.length];
      if((a[1]<=center&&b[1]>center)||(b[1]<=center&&a[1]>center))intersections.push(a[0]+(center-a[1])*(b[0]-a[0])/(b[1]-a[1]));
    }
    intersections.sort((a,b)=>a-b);
    for(let i=0;i+1<intersections.length;i+=2){const x=Math.max(0,Math.ceil(intersections[i]-.5)),r=Math.min(width,Math.ceil(intersections[i+1]-.5));if(r>x)rows.push([x,y,r-x]);}
  }
  return rows;
}
export function sourceIdentity(source) {
  const f=source?.sourceFile || source?.source?.sourceFile;
  return JSON.stringify([source?.processedAsset?.id || source?.processedAsset?.url || (f?[f.name,f.size,f.lastModified]:null),
    source?.targetFps || null,source?.fpsConvertMode || null]);
}
