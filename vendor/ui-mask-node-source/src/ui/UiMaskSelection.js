import { activeAt, poseAt, trackPolygon, ensureTrackChannels, setTrackPose } from '../skills/UiMaskDocument.js';

// Use the actual rotated/path outline, not its unrotated bounding rectangle.
export function polygonTouchesRect(points, rect) {
  if (!points?.length) return false;
  const [x,y,r,b]=rect, inside=p=>p[0]>=x&&p[0]<=r&&p[1]>=y&&p[1]<=b;
  if(points.some(inside))return true;
  const corners=[[x,y],[r,y],[r,b],[x,b]];
  const inPolygon=p=>{let hit=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],q=points[j];if((a[1]>p[1])!==(q[1]>p[1])&&p[0]<(q[0]-a[0])*(p[1]-a[1])/(q[1]-a[1])+a[0])hit=!hit;}return hit;};
  if(corners.some(inPolygon))return true;
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const intersects=(a,b,c,d)=>Math.max(a[0],b[0])>=Math.min(c[0],d[0])&&Math.max(c[0],d[0])>=Math.min(a[0],b[0])&&Math.max(a[1],b[1])>=Math.min(c[1],d[1])&&Math.max(c[1],d[1])>=Math.min(a[1],b[1])&&cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0;
  return points.some((p,i)=>corners.some((q,j)=>intersects(p,points[(i+1)%points.length],q,corners[(j+1)%4])));
}

export function marqueeIds(tracks,frame,source,rect){
  return tracks.filter(t=>activeAt(t,frame)&&polygonTouchesRect(trackPolygon(t,frame,source),rect)).map(t=>t.id);
}
export function combineSelection(before,hits,mode='replace'){
  if(mode==='subtract')return before.filter(id=>!hits.includes(id));
  if(mode==='toggle')return [...before.filter(id=>!hits.includes(id)),...hits.filter(id=>!before.includes(id))];
  return [...new Set(mode==='add'?[...before,...hits]:hits)];
}

// Clamp once for the entire selection so relative spacing cannot change at edges.
export function translateSelection(tracks,ids,frame,delta,source){
  const selected=tracks.filter(t=>ids.includes(t.id)&&activeAt(t,frame));
  if(!selected.length)return tracks;
  const points=selected.flatMap(t=>{const b=poseAt(t,frame).box;return [...trackPolygon(t,frame,source),[b[0],b[1]],[b[2],b[3]]];});
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  const clamp=(v,lo,hi)=>Math.max(Math.min(0,lo),Math.min(Math.max(0,hi),v));
  const dx=clamp(delta[0],-Math.min(...xs),1-Math.max(...xs)),dy=clamp(delta[1],-Math.min(...ys),1-Math.max(...ys));
  if(Math.abs(dx)+Math.abs(dy)<1e-10)return structuredClone(tracks);
  const result=structuredClone(tracks);
  for(const t of result)if(selected.some(p=>p.id===t.id)){
    const pose=poseAt(t,frame),b=pose.box;
    if(t.kind==='dynamic')ensureTrackChannels(t);
    setTrackPose(t,frame,{box:[b[0]+dx,b[1]+dy,b[2]+dx,b[3]+dy],angle:pose.angle});
  }
  return result;
}
