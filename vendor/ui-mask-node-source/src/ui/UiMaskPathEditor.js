import { startEditorGesture } from './EditorInteraction.js';
import { activeAt, poseAt } from '../skills/UiMaskDocument.js';
import { pathAt, setAppearanceValue, vertex, PATH_COORDINATE_LIMIT } from '../skills/UiMaskAppearance.js';
import { pathCoordinates } from './UiMaskPathGeometry.js';
import { insertPathPoint } from './MaskBezierGeometry.js';

export class UiMaskPathEditor {
  constructor(editor) { this.e=editor; this.index=-1; this.showHandles=true; this.addMode=false; this.hoverEdge=-1; this.dragEdge=-1; }
  // 每条边（三次贝塞尔）的中点，路径坐标；闭合路径最后一条边连回第一个点
  edgeMidpoints(path) {
    const count=path.length>=3?path.length:path.length-1,out=[];
    for(let i=0;i<count;i++){
      const v=path[i],n=path[(i+1)%path.length];
      const a=v.point,b=a.map((x,j)=>x+v.out[j]),d=n.point,c=d.map((x,j)=>x+n.in[j]);
      out.push(a.map((_,j)=>(a[j]+3*b[j]+3*c[j]+d[j])/8));
    }
    return out;
  }
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
  // Shotflow：「添加锚点 W」开着时左键点轮廓边缘加点；关着时左键拖边缘整条边一起移动
  toggleAddMode() {
    this.addMode=!this.addMode;
    this.e.status(this.addMode?'添加锚点：在选中遮罩的轮廓边缘单击加点 · W 退出':'已退出添加锚点：拖动边缘可整条边移动');
    this.e.renderTool();this.e.draw();
  }
  // 轮廓边缘命中：返回边的起点下标（这条边连着 i 和 i+1 两个锚点），没命中返回 -1
  edgeHit(screen, path) {
    const {to}=this.coordinates(this.e.track()),r=this.e.canvas.getBoundingClientRect();
    if(path.length>=2){
      const mids=this.edgeMidpoints(path).map(m=>to(m));
      const near=mids.findIndex(q=>Math.hypot((q[0]-screen[0])*r.width,(q[1]-screen[1])*r.height)<12);
      if(near>=0)return near;
    }
    const result=insertPathPoint(path,[screen[0]*r.width,screen[1]*r.height],
      p=>{const q=to(p);return [q[0]*r.width,q[1]*r.height];},8);
    return result?result.index-1:-1;
  }
  keydown(event) {
    if(!this.active()||this.e.keyFocus||event.ctrlKey||event.metaKey||event.altKey)return false;
    if(event.key.toLowerCase()==='w'){if(!event.repeat)this.toggleAddMode();return true;}
    if(['Delete','Backspace'].includes(event.key)&&!event.shiftKey&&this.index>=0){
      if(!event.repeat)this.remove();return true;
    }
    return false;
  }
  draw(ctx=this.e.ctx) {
    if(!this.active())return;
    const e=this.e,t=e.track(),path=pathAt(t,e.frame),{to}=this.coordinates(t);
    const w=e.canvas.width,h=e.canvas.height,scale=w/Math.max(1,e.canvas.getBoundingClientRect().width);
    if(path.length>=2)for(const [i,m] of this.edgeMidpoints(path).entries()){
      const q=to(m),hot=i===this.hoverEdge||i===this.dragEdge,r=(hot?7:5)*scale;
      ctx.beginPath();ctx.arc(q[0]*w,q[1]*h,r,0,Math.PI*2);
      ctx.fillStyle=hot?'#ffe095':'rgba(16,27,41,.92)';ctx.fill();
      ctx.lineWidth=(hot?2:1.5)*scale;ctx.strokeStyle=hot?'#fff3c4':'#8ce1cd';ctx.stroke();
    }
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
    // 直线边上加的点做成没有手柄的角点：边保持直线，也不会在边上冒出两个手柄挡住「拖边」
    const original=pathAt(e.track(),e.frame),from=original[result.index-1],next=original[result.index%original.length];
    const flat=v=>!v||v.every(n=>Math.abs(n)<1e-9);
    if(from&&next&&flat(from.out)&&flat(next.in)){const v=result.path[result.index];v.in=[0,0];v.out=[0,0];}
    this.index=result.index;e.keyFocus=false;return this.save(result.path);
  }
  pointer(event) {
    const e=this.e;
    if(!this.active()||event.shiftKey||event.ctrlKey||event.metaKey)return false;
    const t=e.track(),original=pathAt(t,e.frame),screen=e.point(event,false),hit=this.hit(screen,original);
    if(!hit)return this.edgePointer(event,t,original,screen);
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
  // 鼠标停在选中遮罩的边上时换光标：可拖动整条边显示移动，添加锚点模式显示加号
  hover(event) {
    const e=this.e;
    if(event.buttons||!this.active()||e.video.seeking){if(this.hoverEdge>=0&&!event.buttons){this.hoverEdge=-1;e.draw();}if(this.edgeCursor){this.edgeCursor=false;e.renderTool();}return;}
    const t=e.track(),path=pathAt(t,e.frame),screen=e.point(event,false);
    const edge=this.hit(screen,path)?-1:this.edgeHit(screen,path),onEdge=edge>=0;
    if(edge!==this.hoverEdge){this.hoverEdge=edge;e.draw();}
    if(onEdge){this.edgeCursor=true;e.canvas.style.cursor=this.addMode?'copy':'move';}
    else if(this.edgeCursor){this.edgeCursor=false;e.renderTool();}
  }
  // 按在边上（不是锚点）：添加锚点模式下加点；否则拖动这条边，两端锚点一起平移、曲线手柄跟着走
  edgePointer(event,t,original,screen) {
    const e=this.e;
    if(event.button!==0||event.altKey)return false;
    const i=this.edgeHit(screen,original);
    if(i<0)return false;
    if(!e.canTransform(t))return true;
    if(this.addMode){e.video.pause();this.insert(screen);e.draw();return true;}
    e.video.pause();e.keyFocus=false;e.canvas.focus({preventScroll:true});this.index=-1;e.draw();
    const before=e.snapshot(),{from}=this.coordinates(t),local=from(screen),ends=[i,(i+1)%original.length];
    const bounded=n=>Math.max(-PATH_COORDINATE_LIMIT,Math.min(PATH_COORDINATE_LIMIT,n));
    let moved=false;
    this.dragEdge=i;
    e.canvas.style.cursor='move';
    const update=ev=>{
      if(!moved&&Math.hypot(ev.clientX-event.clientX,ev.clientY-event.clientY)<3)return;
      moved=true;const q=from(e.point(ev,false)),path=structuredClone(original);
      for(const k of ends)path[k].point=path[k].point.map((n,j)=>bounded(n+q[j]-local[j]));
      setAppearanceValue(e.track(),'shape',e.frame,path);e.draw();
    };
    startEditorGesture(event,{element:e.canvas,scope:e.dialog,move:update,
      end:ev=>{update(ev);this.dragEdge=-1;if(moved)e.commit(before);e.renderTool();e.draw();},
      cancel:()=>{this.dragEdge=-1;e.node.document.tracks=before;e.render();}});
    return true;
  }
}
