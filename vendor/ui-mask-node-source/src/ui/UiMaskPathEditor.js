import { startEditorGesture } from './EditorInteraction.js';
import { activeAt, poseAt } from '../skills/UiMaskDocument.js';
import { pathAt, setAppearanceValue, vertex, PATH_COORDINATE_LIMIT } from '../skills/UiMaskAppearance.js';
import { pathCoordinates } from './UiMaskPathGeometry.js';
import { insertPathPoint } from './MaskBezierGeometry.js';

export class UiMaskPathEditor {
  constructor(editor) { this.e=editor; this.index=-1; this.showHandles=true; }
  active() {
    const e=this.e,t=e.track();
    if(this.trackId!==t?.id){this.trackId=t?.id;this.index=-1;}
    if(t&&this.index>=pathAt(t,e.frame).length)this.index=-1;
    return !!t && (e.selectedIds?.size??1)===1 && ['select','path'].includes(e.tool) && activeAt(t,e.frame);
  }
  clearSelection() { this.index=-1; }
  coordinates(t) { return pathCoordinates(poseAt(t,this.e.frame),this.e.node.document.source); }
  toggleHandles() {
    this.showHandles=!this.showHandles;
    this.e.renderTool();this.e.draw();
  }
  keydown(event) {
    if(!this.active()||this.e.keyFocus||event.ctrlKey||event.metaKey||event.altKey)return false;
    if(event.key.toLowerCase()==='w'){if(!event.repeat)this.toggleHandles();return true;}
    if(['Delete','Backspace'].includes(event.key)&&!event.shiftKey&&this.index>=0){
      if(!event.repeat)this.remove();return true;
    }
    return false;
  }
  draw(ctx=this.e.ctx) {
    if(!this.active())return;
    const e=this.e,t=e.track(),path=pathAt(t,e.frame),{to}=this.coordinates(t);
    const w=e.canvas.width,h=e.canvas.height,scale=w/Math.max(1,e.canvas.getBoundingClientRect().width);
    for(const [i,v] of path.entries()){
      const p=to(v.point);
      if(this.showHandles&&i===this.index)for(const side of ['in','out']){
        const q=to(v.point.map((n,j)=>n+v[side][j]));
        ctx.strokeStyle='#e8b97d';ctx.lineWidth=scale;ctx.beginPath();ctx.moveTo(p[0]*w,p[1]*h);ctx.lineTo(q[0]*w,q[1]*h);ctx.stroke();
        ctx.fillStyle='#e8b97d';ctx.beginPath();ctx.arc(q[0]*w,q[1]*h,4*scale,0,Math.PI*2);ctx.fill();
      }
      const radius=(i===this.index?6:4.5)*scale;
      ctx.fillStyle=i===this.index?'#ffe095':'#8ce1cd';
      ctx.fillRect(p[0]*w-radius,p[1]*h-radius,radius*2,radius*2);
    }
  }
  hit(screen, path=pathAt(this.e.track(),this.e.frame)) {
    const {to}=this.coordinates(this.e.track()),r=this.e.canvas.getBoundingClientRect();
    const distance=(a,b)=>Math.hypot((a[0]-b[0])*r.width,(a[1]-b[1])*r.height);
    const v=path[this.index];
    if(this.showHandles&&v)for(const side of ['in','out']){
      const q=to(v.point.map((n,j)=>n+v[side][j]));
      if(distance(q,to(v.point))>5&&distance(q,screen)<10)return {i:this.index,side};
    }
    const i=path.findIndex(v=>distance(to(v.point),screen)<10);
    return i<0?null:{i,side:'point'};
  }
  save(path) {
    const e=this.e,t=e.track();if(!t||!e.canTransform(t))return false;
    e.edit(()=>setAppearanceValue(t,'shape',e.frame,path));return true;
  }
  remove() {
    if(!this.active()||this.index<0)return this.e.status('先点击要删除的锚点');
    const path=pathAt(this.e.track(),this.e.frame);
    if(path.length<=3)return this.e.status('闭合遮罩至少保留三个点；Shift+Delete 删除整块遮罩');
    path.splice(this.index,1);this.index=Math.min(this.index,path.length-1);this.save(path);
  }
  corner(smooth) {
    if(!this.active()||this.index<0)return;
    const path=pathAt(this.e.track(),this.e.frame),v=path[this.index];
    const a=path[(this.index+path.length-1)%path.length].point,b=path[(this.index+1)%path.length].point;
    v.in=smooth?a.map((n,i)=>(n-b[i])/6):[0,0];v.out=smooth?v.in.map(n=>-n):[0,0];this.save(path);
  }
  preset(kind) {
    const k=.2761423749154;
    this.save(kind==='ellipse'?[{point:[.5,0],in:[-k,0],out:[k,0]},{point:[1,.5],in:[0,-k],out:[0,k]},{point:[.5,1],in:[k,0],out:[-k,0]},{point:[0,.5],in:[0,k],out:[0,-k]}]:[vertex(0,0),vertex(1,0),vertex(1,1),vertex(0,1)]);
  }
  insert(screen) {
    const e=this.e;if(!this.active()||!e.canTransform(e.track()))return false;
    const {to}=this.coordinates(e.track()),r=e.canvas.getBoundingClientRect();
    const result=insertPathPoint(pathAt(e.track(),e.frame),[screen[0]*r.width,screen[1]*r.height],
      p=>{const q=to(p);return [q[0]*r.width,q[1]*r.height];});
    if(!result){e.status('在轮廓边缘轻点中键加点；拖动中键平移画面');return false;}
    this.index=result.index;e.keyFocus=false;return this.save(result.path);
  }
  pointer(event) {
    const e=this.e;
    if(!this.active()||event.shiftKey||event.ctrlKey||event.metaKey)return false;
    const t=e.track(),original=pathAt(t,e.frame),screen=e.point(event,false),hit=this.hit(screen,original);
    if(!hit)return false;
    if(!e.canTransform(t))return true;
    e.video.pause();e.keyFocus=false;e.canvas.focus({preventScroll:true});this.index=hit.i;e.draw();
    const before=e.snapshot(),{from}=this.coordinates(t),local=from(screen);
    const bounded=n=>Math.max(-PATH_COORDINATE_LIMIT,Math.min(PATH_COORDINATE_LIMIT,n));
    // Legacy Alt+anchor drag pulls a mirrored tangent from a corner.
    const pullHandle=hit.side==='point'&&event.altKey;
    let moved=false;
    const update=ev=>{
      if(!moved&&Math.hypot(ev.clientX-event.clientX,ev.clientY-event.clientY)<3)return;
      moved=true;const q=from(e.point(ev,false)),path=structuredClone(original),v=path[hit.i];
      if(hit.side==='point'&&!pullHandle)v.point=v.point.map((n,j)=>bounded(n+q[j]-local[j]));
      else{
        const side=pullHandle?'out':hit.side;
        this.showHandles=true;v[side]=q.map((n,j)=>bounded(n-v.point[j]));
        if(pullHandle||!ev.altKey)v[side==='in'?'out':'in']=v[side].map(n=>-n);
      }
      setAppearanceValue(e.track(),'shape',e.frame,path);e.draw();
    };
    startEditorGesture(event,{element:e.canvas,scope:e.dialog,move:update,
      end:ev=>{update(ev);if(moved)e.commit(before);e.renderTool();},
      cancel:()=>{e.node.document.tracks=before;e.render();}});
    return true;
  }
}
