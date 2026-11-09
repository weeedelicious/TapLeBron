import { startEditorGesture, isTextInput } from './EditorInteraction.js';
import { scalarAt, segmentControls } from '../skills/UiMaskAnimation.js';
import { maskDisplayId } from '../skills/UiMaskAppearance.js';
import { PROPERTY_GROUPS, defaultPropertyVisibility, checkedProperties, groupFor, groupMembers, keyId, channel, valueAt, putKey, setValue, setGroupAnimation, groupKeys, deleteKeys, moveKeys, copyKeys, pasteKeys, curvePreset } from '../skills/UiMaskEditing.js';
import { opacityClipHit, opacityClipPixels, trimOpacityRange, moveOpacityRange, removeOpacityRange, pasteOpacityRange, fineEdgeFrame, edgeHoldFrames, shiftedClipKeys, marqueeRefs, clipKeysCanShift } from './opacityClip.js';
const names={x:'位置 X',y:'位置 Y',angle:'旋转',shape:'路径',width:'宽度',height:'高度',opacity:'不透明度'};
const svg=(tag,a={},text)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(a))n.setAttribute(k,v);if(text!=null)n.textContent=text;return n;};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export class UiMaskCurvePanel {
  constructor(e){
    this.e=e;this.prefs=new Map();this.refs=[];this.clipboard=[];this.range=[0,e.node.document.source.frames-1];this.host=e.$('[data-view=keyframes]');
    for(const child of this.host.children)if(!child.classList.contains('ui-mask-timeline-resizer'))child.hidden=true;
    this.root=document.createElement('div');this.root.className='mask-animation';this.host.append(this.root);
    this.root.innerHTML=`<div class="mask-animation-bar"><strong data-id></strong><details class="mask-property-menu"><summary>显示属性</summary><div>${PROPERTY_GROUPS.map(g=>`<label><input type="checkbox" data-show="${g.id}">${g.name}</label>`).join('')}<small>S 为勾选属性设键；取消勾选保留已有动画</small></div></details><button data-mode="timeline" aria-pressed="true">关键帧</button><button data-mode="curve">曲线</button><select data-axis aria-label="曲线属性"></select><label class="mask-carry-keys"><input type="checkbox" data-carry-keys checked>平移带动关键帧</label><span class="mask-spacer"></span><button data-fit="selected">适应选中</button><button data-fit="all">查看全段</button><button data-zoom="out" aria-label="缩小时间轴">−</button><button data-zoom="in" aria-label="放大时间轴">＋</button><button data-more aria-haspopup="menu">更多 ⋯</button></div><div class="mask-tracks"><div class="mask-property-list"></div><div class="mask-plot"><svg tabindex="0" role="group" aria-label="关键帧编辑区域"></svg></div></div><div class="mask-key-detail" hidden></div><div class="mask-animation-hint"></div><div class="mask-key-menu" role="menu" hidden></div>`;
    this.$=s=>this.root.querySelector(s);this.svg=this.$('svg');this.list=this.$('.mask-property-list');this.detail=this.$('.mask-key-detail');this.menu=this.$('.mask-key-menu');this.carryKeys=this.$('[data-carry-keys]');
    this.svg.onpointerdown=ev=>this.pointer(ev);this.svg.onpointermove=ev=>this.clipCursor(ev);this.svg.oncontextmenu=ev=>{ev.preventDefault();if(!this.graph){const clip=this.opacityClipAt(ev);if(clip||this.onOpacityRow(ev)){this.openClipMenu(ev,clip);return;}}this.openMenu(ev);};
    this.list.onscroll=()=>this.drawGraph();
    this.svg.addEventListener('wheel',ev=>{ev.preventDefault();if(ev.shiftKey)this.panRange((this.range[1]-this.range[0])*ev.deltaY/1500);else this.zoom(ev.deltaY<0?.8:1.25,this.at(ev).frame);this.drawGraph();},{passive:false});
    this.$('[data-more]').onclick=()=>this.openMenu();
    for(const b of this.root.querySelectorAll('[data-mode]'))b.onclick=()=>{this.graph=b.dataset.mode==='curve';if(this.graph)this.refs=this.refs.filter(r=>r.p===e.property);this.bounds=null;this.render();};
    for(const b of this.root.querySelectorAll('[data-fit]'))b.onclick=()=>this.fit(b.dataset.fit==='selected');
    for(const b of this.root.querySelectorAll('[data-zoom]'))b.onclick=()=>{this.zoom(b.dataset.zoom==='in'?.65:1.5);this.drawGraph();};
    for(const input of this.root.querySelectorAll('[data-show]'))input.onchange=()=>{this.pref().visible[input.dataset.show]=input.checked;this.manualHeight=null;this.refs=this.refs.filter(r=>this.pref().visible[groupFor(r.p)]);this.render();};
    this.$('[data-axis]').onchange=ev=>{e.property=ev.target.value;this.refs=[];this.bounds=null;this.render();};
    const splitter=e.$('.ui-mask-timeline-resizer');splitter.onpointerdown=ev=>{if(ev.button!==0)return;const h=this.host.clientHeight;startEditorGesture(ev,{element:splitter,scope:e.dialog,move:q=>{this.manualHeight=h+ev.clientY-q.clientY;this.size();},cancel:()=>{this.manualHeight=null;this.size();}});};
    splitter.onkeydown=ev=>{if(['ArrowUp','ArrowDown','Home'].includes(ev.key)){ev.preventDefault();this.manualHeight=ev.key==='Home'?null:this.host.clientHeight+(ev.key==='ArrowUp'?24:-24);this.size();}};
    this.observer=new ResizeObserver(()=>this.drawGraph());this.observer.observe(this.$('.mask-plot'));
    e.dialog.addEventListener('pointerdown',ev=>{if(!this.menu.contains(ev.target)&&!ev.target.closest('[data-more]'))this.menu.hidden=true;},{signal:e.abort.signal});
  }
  pref(){const id=this.e.selected||'empty';if(!this.prefs.has(id))this.prefs.set(id,{inspect:false,visible:defaultPropertyVisibility()});return this.prefs.get(id);}
  setExpanded(){}
  read(){const t=this.e.track();return t?structuredClone(t):null;}
  groups(){return PROPERTY_GROUPS.filter(g=>this.pref().visible[g.id]);}
  factor(p=this.e.property){return p==='opacity'?100:p==='angle'?1:this.e.node.document.source[['x','width'].includes(p)?'width':'height'];}
  inspect(on){this.pref().inspect=on;this.refs=[];this.e.keyFocus=false;this.render();}
  selected(refs){this.refs=refs;if(refs.length)this.clipIndex=null;this.e.keyFocus=true;this.e.selectedKey=refs[0]?.frame??null;}
  render(){
    const e=this.e,t=this.read();if(this.trackId!==t?.id){this.trackId=t?.id;this.refs=[];this.bounds=null;this.manualHeight=null;this.pref().inspect=false;}
    this.host.hidden=!t||!this.pref().inspect;e.inspectToggle.checked=this.pref().inspect;e.inspectToggle.disabled=!t;if(!t)return;
    const groups=this.groups(),props=groups.flatMap(g=>g.members);this.hasMatch=!!props.length;if(!props.includes(e.property))e.property=props[0]||'x';
    this.refs=this.refs.filter(r=>t.kind==='dynamic'&&props.includes(r.p)&&channel(t,r.p).keys.some(k=>k.frame===r.frame));this.$('[data-id]').textContent=`${maskDisplayId(t)} · ${t.label}${e.selectedIds?.size>1?' · 属性仅修改主选':''}`;
    for(const input of this.root.querySelectorAll('[data-show]'))input.checked=!!this.pref().visible[input.dataset.show];
    this.$('[data-axis]').replaceChildren(...props.map(p=>new Option(names[p],p)));this.$('[data-axis]').value=e.property;this.$('[data-axis]').hidden=!this.graph;this.$('[data-axis]').setAttribute('aria-label','曲线属性');this.$('[data-axis]').title='选择查看的曲线；S 按显示属性的勾选设键';
    for(const b of this.root.querySelectorAll('[data-mode]'))b.setAttribute('aria-pressed',String((b.dataset.mode==='curve')===!!this.graph));
    this.list.replaceChildren();for(const g of groups){
      const row=document.createElement('div');row.className='mask-property';row.dataset.group=g.id;row.classList.toggle('active',g.id===groupFor(e.property));const animated=g.members.some(p=>channel(t,p).keys.length>0);
      row.innerHTML=`<button class="mask-stopwatch" aria-label="${g.name}动画" aria-pressed="${animated}" title="${animated?'关闭动画并保留当前值':'开启动画，在当前帧记录'}">◷</button><button class="mask-property-name">${g.name}</button><div class="mask-values"></div><button class="mask-add-key" aria-label="${g.name}添加关键帧" title="当前帧设键">◇</button>`;
      row.querySelector('.mask-property-name').onclick=()=>{e.property=g.members[0];this.bounds=null;this.render();};
      row.querySelector('.mask-stopwatch').disabled=t.kind==='static'||e.node.busy;row.querySelector('.mask-stopwatch').onclick=()=>e.edit(()=>{e.property=g.members[0];this.bounds=null;setGroupAnimation(e.track(),g.id,e.frame,!animated);this.selected(animated?[]:(g.id==='shape'?['shape']:g.members).map(p=>({p,frame:e.frame})));});
      row.querySelector('.mask-add-key').disabled=t.kind==='static'||e.node.busy;row.querySelector('.mask-add-key').onclick=()=>this.add(e.frame,g.id);
      const values=row.querySelector('.mask-values');if(g.id==='shape'){const b=document.createElement('button');b.textContent=e.tool==='path'?'完成路径':'编辑路径';b.onclick=()=>{e.setTool(e.tool==='path'?'select':'path');e.property='shape';this.render();};values.append(b);}else for(const p of g.members){const input=document.createElement('input');input.type='number';input.step='any';input.dataset.value=p;input.onfocus=()=>{e.property=p;this.bounds=null;this.$('[data-axis]').value=p;this.renderDetail();this.drawGraph();};input.setAttribute('aria-label',names[p]);input.title=`${names[p]} · ${p==='opacity'?'%':p==='angle'?'°':'px'}`;input.value=+(valueAt(t,p,e.frame)*this.factor(p)).toFixed(2);input.disabled=e.node.busy;this.bind(input,()=>e.edit(()=>setValue(e.track(),p,e.frame,Number(input.value)/this.factor(p))));values.append(input);}this.list.append(row);
    }
    this.root.classList.toggle('graph',!!this.graph);this.$('.mask-tracks').hidden=!groups.length;this.renderDetail();this.size();this.drawGraph();
    this.$('.mask-animation-hint').textContent=!groups.length?'勾选「显示属性」，再开始调整。':e.tool==='path'?'拖动锚点和手柄 · 双击边缘加点 · Alt 拖锚点拉曲线 · W 手柄 · S 为已勾选属性设键 · Delete 删点':this.graph?`S 为已勾选属性设键 · 拖动移键 · Shift 多选 / 框选 · 右键添加 · Delete 删除 · 滚轮缩放 · Shift 滚轮 / 中键平移`:'不透明度片段拖两端拉长缩短 · 按住 Shift 拖边缘按 1 帧微调 · 方向键继续微调同一边 · 拖中间整段移动';
  }
  bind(input,fn){input.oninput=()=>input.dataset.dirty='1';input.onchange=input.onblur=()=>{if(!input.dataset.dirty||input.value==='')return;delete input.dataset.dirty;fn();};input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();input.onchange();input.blur();}};}
  size(){const count=this.groups().length,desired=count?(this.graph?268:110+count*42):48,max=Math.max(120,this.e.dialog.clientHeight*.42),height=clamp(this.manualHeight??desired,count?130:48,max);this.host.style.height=`${height}px`;this.host.style.minHeight=count?'130px':'48px';this.host.style.maxHeight=`${max}px`;const handle=this.e.$('.ui-mask-timeline-resizer');handle.setAttribute('aria-valuemin',count?130:48);handle.setAttribute('aria-valuemax',Math.round(max));handle.setAttribute('aria-valuenow',Math.round(height));handle.setAttribute('aria-valuetext',`${Math.round(height)} 像素`);}
  updateCursor(){if(this.dragging)return;const t=this.read();if(!t)return;for(const input of this.root.querySelectorAll('[data-value]'))if(document.activeElement!==input)input.value=+(valueAt(t,input.dataset.value,this.e.frame)*this.factor(input.dataset.value)).toFixed(2);this.drawGraph();}
  geometry(){const w=Math.max(100,this.$('.mask-plot').clientWidth),h=Math.max(40,this.$('.mask-plot').clientHeight);return {w,h,left:this.graph?58:16,right:w-18,top:27,bottom:h-18};}
  axis(t){if(!this.bounds){const c=t.kind==='static'?{value:valueAt(t,this.e.property,this.e.frame),keys:[]}:channel(t,this.e.property),v=[c.value,...c.keys.map(k=>k.value)].filter(Number.isFinite);if(!v.length)v.push(0,1);const lo=Math.min(...v),hi=Math.max(...v),pad=Math.max((hi-lo)*.18,1/this.factor());this.bounds=[lo-pad,hi+pad];}return this.bounds;}
  at(ev){const r=this.svg.getBoundingClientRect(),g=this.geometry(),x=ev.clientX-r.left,y=ev.clientY-r.top,b=this.bounds||[0,1];return {x,y,frame:Math.round(this.range[0]+(x-g.left)/(g.right-g.left)*(this.range[1]-this.range[0])),value:b[1]-(y-g.top)/(g.bottom-g.top)*(b[1]-b[0]),group:this.groups()[Math.floor((y-27+this.list.scrollTop)/42)]?.id||groupFor(this.e.property)};}
  drawGraph(){
    if(!this.svg||this.dragging)return;const t=this.read();this.svg.replaceChildren();if(!t||!this.groups().length)return;const g=this.geometry(),span=Math.max(1,this.range[1]-this.range[0]),x=f=>g.left+(f-this.range[0])/span*(g.right-g.left);this.svg.setAttribute('viewBox',`0 0 ${g.w} ${g.h}`);
    const bounds=this.graph?this.axis(t):[0,1],y=v=>g.bottom-(v-bounds[0])/(bounds[1]-bounds[0])*(g.bottom-g.top);this.keyPoints=[];
    const defs=svg('defs'),clip=svg('clipPath',{id:'mask-graph-clip'});clip.append(svg('rect',{x:g.left-7,y:20,width:g.right-g.left+14,height:g.h-20}));defs.append(clip);this.svg.append(defs);const layer=svg('g',{'clip-path':'url(#mask-graph-clip)'});this.svg.append(layer);
    const step=Math.max(1,Math.ceil(span/Math.max(2,Math.floor((g.right-g.left)/100))));for(let f=Math.ceil(this.range[0]/step)*step;f<=this.range[1];f+=step)this.svg.append(svg('line',{x1:x(f),x2:x(f),y1:22,y2:g.h,stroke:'#29394b'}),svg('text',{x:x(f)+3,y:16,class:'curve-label'},f+1));
    const point=(refs,px,py)=>{if(px<g.left-1||px>g.right+1)return;const selected=refs.some(r=>this.refs.some(s=>keyId(s)===keyId(r))),n=svg(this.graph?'circle':'path',this.graph?{cx:px,cy:py,r:5}:{d:`M${px} ${py-5}l5 5 -5 5 -5 -5Z`});n.setAttribute('class',`mask-key${selected?' selected':''}`);n.dataset.refs=JSON.stringify(refs);n.setAttribute('aria-label',`${names[refs[0].p]} 第 ${refs[0].frame+1} 帧`);layer.append(n);this.keyPoints.push({refs,x:px,y:py});};
    if(this.graph&&this.e.property!=='shape'){
      for(let i=0;i<3;i++){const v=bounds[0]+i*(bounds[1]-bounds[0])/2,py=y(v);this.svg.append(svg('line',{x1:g.left,x2:g.right,y1:py,y2:py,stroke:'#2b3b4e'}),svg('text',{x:g.left-7,y:py+3,'text-anchor':'end',class:'curve-label'},+(v*this.factor()).toFixed(2)));}
      const c=t.kind==='static'?{value:valueAt(t,this.e.property,this.e.frame),keys:[]}:channel(t,this.e.property);let d='';for(let px=g.left;px<=g.right;px+=2){const f=this.range[0]+(px-g.left)/(g.right-g.left)*span;d+=`${px===g.left?'M':'L'}${px} ${y(scalarAt(c,f,t.ranges))} `;}layer.append(svg('path',{d,class:'curve-line'}));
      for(const k of c.keys)if(this.keyVisible(t,k.frame))point([{p:this.e.property,frame:k.frame}],x(k.frame),y(k.value));
      if(this.refs.length===1&&this.refs[0].p===this.e.property){const i=c.keys.findIndex(k=>k.frame===this.refs[0].frame),key=c.keys[i];if(key)for(const side of ['in','out']){const other=c.keys[i+(side==='in'?-1:1)];if(!other)continue;const seg=side==='in'?segmentControls(other,key):segmentControls(key,other),p=seg[side==='in'?2:1],hx=x(p[0]),hy=y(p[1]);layer.append(svg('line',{x1:x(key.frame),y1:y(key.value),x2:hx,y2:hy,class:'curve-handle-line'}));const h=svg('circle',{cx:hx,cy:hy,r:4,class:'curve-handle'});h.dataset.handle=side;layer.append(h);}}
    }else for(const [i,group] of this.groups().entries()){const py=48+i*42-this.list.scrollTop;layer.append(svg('line',{x1:g.left,x2:g.right,y1:py+20,y2:py+20,stroke:'#263548'}));if(group.id==='opacity')this.drawOpacityClips(layer,t,x,py);else for(const k of t.kind==='dynamic'?groupKeys(t,group.id):[])if(this.keyVisible(t,k.frame))point(k.refs,x(k.frame),py);}
    this.svg.append(svg('line',{x1:x(this.e.frame),x2:x(this.e.frame),y1:21,y2:g.h,stroke:'#edcf8b','pointer-events':'none'}));
  }
  keyVisible(track,frame){return !track.ranges?.length||track.ranges.some(([start,end])=>frame>=start&&frame<end);}
  drawOpacityClips(layer,track,x,py){
    const y=py+8;this.opacityNodes=[];
    track.ranges.forEach((range,index)=>{
      const {start:x0,end:x1}=opacityClipPixels(range,x),selected=Number(this.e.field('range').value)===index;
      const body=svg('rect',{x:x0,y,width:Math.max(12,x1-x0),height:24,rx:4,class:`mask-opacity-clip${selected?' selected':''}`});
      const startEdge=svg('rect',{x:x0,y:y-6,width:12,height:36,rx:2,class:'mask-opacity-edge'});
      const endEdge=svg('rect',{x:x1-12,y:y-6,width:12,height:36,rx:2,class:'mask-opacity-edge'});
      body.dataset.opacityClip=String(index);layer.append(body,startEdge,endEdge);
      const label=x1-x0>64?svg('text',{x:(x0+x1)/2,y:y+16,'text-anchor':'middle',class:'curve-label'},`${range[0]+1}–${range[1]}`):null;
      if(label)layer.append(label);
      this.opacityNodes.push({index,body,startEdge,endEdge,label});
    });
  }
  layoutOpacityClips(ranges){
    if(!this.opacityNodes?.length)return false;
    const x=this.frameX();if(!x)return false;
    for(const node of this.opacityNodes){
      const range=ranges[node.index];if(!range)return false;
      const {start:x0,end:x1}=opacityClipPixels(range,x);
      node.body.setAttribute('x',x0);node.body.setAttribute('width',Math.max(12,x1-x0));
      node.startEdge.setAttribute('x',x0);node.endEdge.setAttribute('x',x1-12);
      if(node.label){node.label.setAttribute('x',(x0+x1)/2);node.label.textContent=`${range[0]+1}–${range[1]}`;}
    }
    return true;
  }
  frameX(){const geometry=this.geometry(),span=Math.max(1,this.range[1]-this.range[0]);return frame=>geometry.left+(frame-this.range[0])/span*(geometry.right-geometry.left);}
  opacityClipAt(ev){
    const track=this.read();if(!track?.ranges?.length||this.graph)return null;
    const index=this.groups().findIndex(group=>group.id==='opacity');if(index<0)return null;
    const pos=this.at(ev),py=48+index*42-this.list.scrollTop;
    if(pos.y<py||pos.y>py+42)return null;
    const geometry=this.geometry(),span=Math.max(1,this.range[1]-this.range[0]);
    return opacityClipHit(track.ranges,frame=>geometry.left+(frame-this.range[0])/span*(geometry.right-geometry.left),pos.x);
  }
  clipCursor(ev){
    if(this.dragging)return;
    const hit=this.opacityClipAt(ev);
    this.svg.style.cursor=hit&&hit.edge!=='body'?'ew-resize':hit?'pointer':'';
  }
  trimOpacityClip(ev,hit){
    const e=this.e,before=e.snapshot(),frames=e.node.document.source.frames,original=e.track().ranges.map(range=>[...range]);
    this.selectOpacityClip(hit.index,hit.edge);this.dragging=true;
    startEditorGesture(ev,{element:this.svg,scope:e.dialog,move:q=>{
      const base=hit.edge==='start'?original[hit.index][0]:original[hit.index][1];
      let frame=q.shiftKey?fineEdgeFrame(base,q.clientX-ev.clientX):clamp(this.at(q).frame,0,frames-1)+(hit.edge==='end'?1:0);
      if(!q.altKey&&!q.shiftKey){
        if(hit.edge==='start'&&Math.abs(frame-e.frame)<=1)frame=e.frame;
        if(hit.edge==='end'&&Math.abs(frame-(e.frame+1))<=1)frame=e.frame+1;
      }
      e.track().ranges=trimOpacityRange(original,hit.index,hit.edge,frame,frames);
      if(!this.layoutOpacityClips(e.track().ranges))this.drawGraph();e.renderRange();
    },end:()=>{this.dragging=false;this.holdExpandedEdge(e.track(),original[hit.index],e.track().ranges[hit.index]);e.commit(before);},cancel:()=>{this.dragging=false;e.node.document.tracks=before;this.render();e.draw();}});
  }
  moveOpacityClip(ev,hit){
    const e=this.e,before=e.snapshot(),frames=e.node.document.source.frames,original=e.track().ranges.map(range=>[...range]),origin=this.at(ev).frame;
    this.selectOpacityClip(hit.index);let moved=false,accepted=original.map(range=>[...range]);this.dragging=true;
    startEditorGesture(ev,{element:this.svg,scope:e.dialog,move:q=>{
      moved=moved||Math.hypot(q.clientX-ev.clientX,q.clientY-ev.clientY)>3;
      if(!moved)return;
      let delta=clamp(this.at(q).frame,0,frames)-origin;
      if(!q.altKey&&Math.abs(original[hit.index][0]+delta-e.frame)<=1)delta=e.frame-original[hit.index][0];
      const next=moveOpacityRange(original,hit.index,delta,frames),shift=next[hit.index][0]-original[hit.index][0];
      if(this.carriesKeys()&&shift&&!this.clipShiftFits(e.track(),original[hit.index],shift,frames)){e.track().ranges=accepted.map(range=>[...range]);if(!this.layoutOpacityClips(e.track().ranges))this.drawGraph();this.slideClipKeys(original[hit.index],accepted[hit.index][0]-original[hit.index][0]);return;}
      accepted=next.map(range=>[...range]);e.track().ranges=accepted.map(range=>[...range]);
      if(!this.layoutOpacityClips(e.track().ranges))this.drawGraph();e.renderRange();
      this.slideClipKeys(original[hit.index],shift);
    },end:()=>{this.dragging=false;if(!moved){this.drawGraph();return;}const shift=e.track().ranges[hit.index][0]-original[hit.index][0];if(this.carriesKeys()&&shift){if(!this.clipShiftFits(e.track(),original[hit.index],shift,frames)){e.node.document.tracks=before;this.render();e.draw();e.status('目标位置放不下这些关键帧，滑块没有移动');return;}try{moveKeys(e.track(),this.clipKeyRefs(e.track(),original[hit.index]),shift,frames);}catch(err){e.node.document.tracks=before;this.render();e.draw();e.status(err.message);return;}}e.commit(before);if(this.carriesKeys()&&shift)e.status('已平移这段，并带走其中的关键帧');},cancel:()=>{this.dragging=false;e.node.document.tracks=before;this.render();e.draw();}});
  }
  pointer(ev){
    const e=this.e;if(ev.button===2)return;const pos=this.at(ev),target=ev.target.closest('[data-refs]'),handle=ev.target.dataset.handle;e.video.pause();e.keyFocus=true;this.svg.focus({preventScroll:true});
    if(ev.button===1||ev.altKey&&!target&&!handle){const before=[...this.range],bounds=this.bounds&&[...this.bounds],g=this.geometry();startEditorGesture(ev,{element:this.svg,scope:e.dialog,move:q=>{this.range=[...before];this.panRange((ev.clientX-q.clientX)/(g.right-g.left)*(before[1]-before[0]));if(bounds&&this.graph){const d=(q.clientY-ev.clientY)/(g.bottom-g.top)*(bounds[1]-bounds[0]);this.bounds=bounds.map(v=>v+d);}this.drawGraph();},cancel:()=>{this.range=before;this.bounds=bounds;this.drawGraph();}});return;}
    if(ev.button===0&&!ev.altKey&&!this.graph&&!e.node.busy){const clip=this.opacityClipAt(ev);if(clip){e.video.pause();this.selectOpacityClip(clip.index);if(clip.edge==='body'){this.moveOpacityClip(ev,clip);return;}this.trimOpacityClip(ev,clip);return;}}
    if(ev.button!==0||e.node.busy)return;if(e.track()?.kind==='static'){e.seek(pos.frame);return;}
    if(handle&&this.refs.length===1&&!ev.shiftKey){const ref=this.refs[0],before=e.snapshot(),c=channel(e.track(),ref.p),key=c.keys.find(k=>k.frame===ref.frame);if(!key)return;startEditorGesture(ev,{element:this.svg,scope:e.dialog,move:q=>{const p=this.at(q);key[handle]=[clamp(p.frame-key.frame,handle==='in'?-e.node.document.source.frames:0,handle==='in'?0:e.node.document.source.frames),clamp(p.value-key.value,ref.p==='angle'?-72000:-4,ref.p==='angle'?72000:4)];if(handle==='out')key.interpolation='bezier';else if(c.keys.indexOf(key))c.keys[c.keys.indexOf(key)-1].interpolation='bezier';this.drawGraph();e.draw();},end:()=>e.commit(before),cancel:()=>{e.node.document.tracks=before;this.render();e.draw();}});return;}
    if(e.track()?.kind==='dynamic'&&(ev.shiftKey||(!target&&pos.y>=this.geometry().top))){this.marquee(ev,pos,target,!ev.shiftKey);return;}
    if(target){const hit=JSON.parse(target.dataset.refs);e.property=hit[0].p;this.$('[data-axis]').value=e.property;const exists=hit.some(r=>this.refs.some(s=>keyId(s)===keyId(r)));if(!exists)this.selected(hit);this.drawGraph();this.renderDetail();const refs=structuredClone(this.refs),before=e.snapshot(),origin=this.at(ev);let delta=0,changes={},moved=false;this.dragging=true;
      startEditorGesture(ev,{element:this.svg,scope:e.dialog,move:q=>{const p=this.at(q);moved=Math.hypot(q.clientX-ev.clientX,q.clientY-ev.clientY)>3;delta=p.frame-origin.frame;changes={};if(this.graph&&e.property!=='shape')for(const r of refs){const k=channel(before.find(t=>t.id===e.selected),r.p).keys.find(k=>k.frame===r.frame);changes[keyId(r)]=k.value+p.value-origin.value;}for(const n of this.svg.querySelectorAll('[data-refs]'))if(JSON.parse(n.dataset.refs).some(r=>refs.some(s=>keyId(s)===keyId(r))))n.setAttribute('transform',`translate(${q.clientX-ev.clientX},${this.graph?q.clientY-ev.clientY:0})`);},end:()=>{this.dragging=false;if(moved)e.edit(()=>this.selected(moveKeys(e.track(),refs,delta,e.node.document.source.frames,changes)));else e.seek(hit[0].frame);this.render();},cancel:()=>{this.dragging=false;this.render();}});return;
    }
    this.selected([]);const scrub=q=>e.seek(clamp(this.at(q).frame,0,e.node.document.source.frames-1));scrub(ev);startEditorGesture(ev,{element:this.svg,scope:e.dialog,move:scrub,end:()=>this.render()});
  }
  marquee(ev,pos,target,replace){
    const e=this.e,points=[...this.keyPoints],prior=[...this.refs],box=svg('rect',{class:'mask-marquee',x:pos.x,y:pos.y,width:0,height:0});
    this.svg.append(box);this.dragging=true;let moved=false,chosen=[];
    startEditorGesture(ev,{element:this.svg,scope:e.dialog,move:q=>{
      moved=moved||Math.hypot(q.clientX-ev.clientX,q.clientY-ev.clientY)>3;
      const p=this.at(q),x=Math.min(pos.x,p.x),y=Math.min(pos.y,p.y),w=Math.abs(p.x-pos.x),h=Math.abs(p.y-pos.y);
      for(const [k,v] of Object.entries({x,y,width:w,height:h}))box.setAttribute(k,v);
      chosen=marqueeRefs(points,{x1:pos.x,y1:pos.y,x2:p.x,y2:p.y});
    },end:()=>{
      this.dragging=false;
      if(!moved){
        if(target&&ev.shiftKey){const hit=JSON.parse(target.dataset.refs),exists=hit.some(r=>prior.some(s=>keyId(s)===keyId(r)));this.selected(exists?prior.filter(s=>!hit.some(r=>keyId(r)===keyId(s))):[...prior,...hit]);}
        else if(!target){this.selected([]);e.seek(pos.frame);}
      }else this.selected([...new Map([...(replace?[]:prior),...chosen].map(r=>[keyId(r),r])).values()]);
      this.render();
    },cancel:()=>{this.dragging=false;this.render();}});
  }
  add(frame=this.e.frame,group,property=this.e.property){
    return this.addMembers(frame,group?(group==='shape'?['shape']:groupMembers(group)):[property]);
  }
  addChecked(){
    const focus=this.e.keyFocus;
    this.addMembers(this.e.frame,checkedProperties(this.pref().visible));
    // A viewport shortcut must not redirect Delete to the timeline.
    this.e.keyFocus=focus;
  }
  addMembers(frame,members){
    const e=this.e;
    if(e.node.busy)return;
    if(!members.length)return e.status('未勾选属性，没有添加关键帧；请在「显示属性」中选择');
    if(e.track()?.kind!=='dynamic')return e.status('静态遮罩不设置动画；可在遮罩设置中切换类别');
    if(!e.track().ranges.some(([a,b])=>frame>=a&&frame<b))return e.status('请先定位到遮罩出现时段');
    e.video.pause();
    e.edit(()=>{
      for(const p of members)putKey(e.track(),p,frame);
      this.selected(members.map(p=>({p,frame})));
    });
    e.status(`已给${members.map(p=>names[p]).join('、')}设键（第 ${frame+1} 帧）`);
  }
  remove(){if(this.e.track()?.kind==='dynamic'&&this.refs.length)this.e.edit(()=>{deleteKeys(this.e.track(),this.refs);this.selected([]);});}
  preset(name){if(this.e.track()?.kind!=='dynamic')return;if(!this.refs.length)return this.e.status('先选中要调整的关键帧');this.e.edit(()=>{for(const r of this.refs)curvePreset(this.e.track(),r.p,r.frame,name);});}
  copy(){if(this.e.track()&&this.refs.length){this.clipboard=copyKeys(this.read(),this.refs);this.e.status(`已复制 ${this.clipboard.length} 个属性关键帧`);}}
  paste(frame=this.e.frame){if(this.e.track()?.kind==='dynamic')this.e.edit(()=>this.selected(pasteKeys(this.e.track(),this.clipboard,frame,this.e.node.document.source.frames)));}
  keydown(ev){
    if(!this.e.keyFocus||isTextInput(ev.target))return false;
    const key=ev.key.toLowerCase(),mod=ev.ctrlKey||ev.metaKey;
    // Shift deletion belongs to the editor's whole-mask command, even with timeline focus.
    if(ev.shiftKey&&(key==='delete'||key==='backspace'))return false;
    if(mod&&key==='c'){if(this.clipIndex!=null&&!this.refs.length){this.copyOpacityClip();return true;}this.copy();return true;}
    if(mod&&key==='v'){if(this.clipIndex!=null&&!this.refs.length){this.pasteOpacityClip(this.e.frame);return true;}this.paste();return true;}
    if(mod&&key==='a'){const t=this.read();if(t)this.selected(this.graph?channel(t,this.e.property).keys.map(k=>({p:this.e.property,frame:k.frame})):this.groups().flatMap(g=>groupKeys(t,g.id).flatMap(k=>k.refs)));this.render();return true;}
    if((ev.key==='ArrowLeft'||ev.key==='ArrowRight')&&this.clipIndex!=null&&this.clipEdge&&!this.refs.length&&!mod){this.nudgeOpacityEdge(ev.key==='ArrowLeft'?-1:1);return true;}
    if((key==='delete'||key==='backspace')&&this.clipIndex!=null&&!this.refs.length){this.deleteOpacityClip(this.clipIndex);return true;}
    if(key==='delete'||key==='backspace'){this.clipIndex=null;this.remove();return true;}
    if(ev.key==='ContextMenu'||ev.shiftKey&&ev.key==='F10'){this.openMenu();return true;}
    return false;
  }
  selectOpacityClip(index,edge=null){this.clipIndex=index;this.clipEdge=edge;this.selected([]);this.e.field('range').value=String(index);this.e.renderRange();}
  holdExpandedEdge(track,oldRange,newRange){
    if(!track)return;
    const props=['x','y','angle','width','height','shape'];
    for(const {source,dest} of edgeHoldFrames(oldRange,newRange)){
      for(const p of props){
        const keys=p==='shape'?track.appearance?.shape?.keys:track.animation?.channels?.[p]?.keys;
        if(!keys?.length||keys.some(key=>key.frame===dest))continue;
        putKey(track,p,dest,valueAt(track,p,source));
      }
    }
  }
  nudgeOpacityEdge(delta){
    const e=this.e,track=e.track(),range=track?.ranges[this.clipIndex];
    if(!range||!this.clipEdge||e.node.busy)return;
    const old=[...range],frame=(this.clipEdge==='start'?range[0]:range[1])+delta;
    e.edit(()=>{const current=e.track();current.ranges=trimOpacityRange(current.ranges,this.clipIndex,this.clipEdge,frame,e.node.document.source.frames);this.holdExpandedEdge(current,old,current.ranges[this.clipIndex]);});
    e.status(this.clipEdge==='start'?'已微调出现帧':'已微调结束帧');
  }
  deleteOpacityClip(index){
    const e=this.e,track=e.track();
    if(!track||e.node.busy||!track.ranges[index])return;
    e.edit(()=>{track.ranges=removeOpacityRange(track.ranges,index);});
    const count=e.track()?.ranges.length||0;
    this.clipIndex=count?Math.min(index,count-1):null;
    if(this.clipIndex==null)e.field('range').value='';
    else e.field('range').value=String(this.clipIndex);
    e.renderRange();this.drawGraph();
    e.status(count?'已删除这段不透明度':'已删除这段，当前遮罩没有出现时间');
  }
  propertyKeys(track,p){return p==='shape'||p==='opacity'?track.appearance?.[p]?.keys:track.animation?.channels?.[p]?.keys;}
  carriesKeys(){return this.carryKeys?.checked!==false;}
  clipKeyRefs(track,range){const refs=[];for(const p of ['x','y','angle','width','height','shape'])for(const key of channel(track,p)?.keys||[])if(key.frame>=range[0]&&key.frame<range[1])refs.push({p,frame:key.frame});return refs;}
  clipShiftFits(track,range,delta,frameCount){const framesByProperty={};for(const p of ['x','y','angle','width','height','shape'])framesByProperty[p]=(channel(track,p)?.keys||[]).map(key=>key.frame);return clipKeysCanShift(framesByProperty,range,delta,frameCount);}
  slideClipKeys(range,deltaFrames){if(!this.carriesKeys())return;const x=this.frameX();if(!x)return;const dx=deltaFrames?x(range[0]+deltaFrames)-x(range[0]):0;for(const node of this.svg.querySelectorAll('[data-refs]')){let refs=[];try{refs=JSON.parse(node.dataset.refs);}catch{continue;}if(refs.some(ref=>ref.frame>=range[0]&&ref.frame<range[1])){if(dx)node.setAttribute('transform',`translate(${dx},0)`);else node.removeAttribute('transform');}}}
  copyOpacityClip(){
    const track=this.e.track(),range=track?.ranges[this.clipIndex];
    if(!range)return;
    const keys=[];
    for(const p of ['x','y','angle','width','height','shape'])for(const key of this.propertyKeys(track,p)||[])if(key.frame>=range[0]&&key.frame<range[1])keys.push({p,frame:key.frame,key:structuredClone(key)});
    this.clipClipboard={length:range[1]-range[0],start:range[0],keys};
    this.e.status(`已复制这段（${this.clipClipboard.length} 帧，${keys.length} 个关键帧）`);
  }
  pasteOpacityClip(frame){
    const e=this.e,track=e.track();
    if(!track||e.node.busy)return;
    const clip=this.clipClipboard;
    if(!clip)return e.status('还没有复制不透明度片段');
    const pasted=pasteOpacityRange(track.ranges,frame,clip.length,e.node.document.source.frames);
    if(pasted.index==null)return e.status('这一帧没有空位，不能粘贴');
    let result={refs:[],skipped:0};
    e.edit(()=>{const current=e.track();current.ranges=pasted.ranges;result=this.pasteClipKeys(current,clip,current.ranges[pasted.index]);});
    if(result.refs.length)this.selected(result.refs);else this.selectOpacityClip(pasted.index);
    this.drawGraph();
    e.status(result.skipped?`已粘贴这段和 ${result.refs.length} 个关键帧，${result.skipped} 个因目标帧已有关键帧未覆盖`:`已粘贴这段和 ${result.refs.length} 个关键帧`);
  }
  pasteClipKeys(track,clip,dest){
    const taken=[];
    for(const p of ['x','y','angle','width','height','shape'])for(const key of this.propertyKeys(track,p)||[])taken.push(`${p}:${key.frame}`);
    const {copies,skipped}=shiftedClipKeys(clip.keys||[],clip.start,dest,taken),refs=[];
    for(const copy of copies){const list=this.propertyKeys(track,copy.p);if(!list)continue;const next=structuredClone(copy.key);next.frame=copy.frame;list.push(next);refs.push({p:copy.p,frame:copy.frame});}
    for(const p of new Set(refs.map(ref=>ref.p))){const list=this.propertyKeys(track,p);list.sort((a,b)=>a.frame-b.frame);if(p==='shape')for(let i=0;i<list.length-1;i++)if(list[i].value.length!==list[i+1].value.length)list[i].interpolation='hold';}
    return {refs,skipped};
  }
  onOpacityRow(ev){
    const index=this.groups().findIndex(group=>group.id==='opacity');if(index<0)return false;
    const pos=this.at(ev),py=48+index*42-this.list.scrollTop;
    return pos.y>=py&&pos.y<=py+42;
  }
  openClipMenu(ev,clip){
    const e=this.e,track=this.read();if(!track)return;
    if(clip){if(!track.ranges[clip.index])return;this.selectOpacityClip(clip.index);this.drawGraph();}
    e.keyFocus=true;this.svg.focus({preventScroll:true});
    const range=clip&&track.ranges[clip.index];
    this.menu.replaceChildren();
    const title=document.createElement('strong');title.textContent=range?`${range[0]+1}–${range[1]} 帧`:'不透明度片段';this.menu.append(title);
    const items=clip?[['跳到这段',()=>e.seek(range[0]),false],['复制这段',()=>this.copyOpacityClip(),false],['在此粘贴',()=>this.pasteOpacityClip(this.at(ev).frame),!this.clipClipboard],['删除这段',()=>this.deleteOpacityClip(clip.index),e.node.busy]]:[['在此粘贴',()=>this.pasteOpacityClip(this.at(ev).frame),!this.clipClipboard]];
    for(const [name,fn,disabled] of items){
      const button=document.createElement('button');button.textContent=name;button.disabled=disabled;button.setAttribute('role','menuitem');button.onclick=()=>{this.menu.hidden=true;fn();};this.menu.append(button);
    }
    this.menu.hidden=false;const box=this.menu.getBoundingClientRect();
    this.menu.style.left=`${clamp(ev.clientX,6,window.innerWidth-box.width-6)}px`;
    this.menu.style.top=`${clamp(ev.clientY,6,window.innerHeight-box.height-6)}px`;
    this.menu.querySelector('button:not(:disabled)')?.focus();
  }
  openMenu(ev){this.clipIndex=null;const e=this.e,t=this.read();if(!t||!this.groups().length)return;let q=ev?this.at(ev):{frame:e.frame,group:groupFor(e.property)},frame=clamp(q.frame,0,e.node.document.source.frames-1);const hit=ev?.target.closest('[data-refs]');if(hit){const refs=JSON.parse(hit.dataset.refs);if(!refs.some(r=>this.refs.some(s=>keyId(r)===keyId(s))))this.selected(refs);frame=refs[0].frame;this.renderDetail();this.drawGraph();}this.menu.replaceChildren();const title=document.createElement('strong');title.textContent=`${maskDisplayId(t)} · 第 ${frame+1} 帧`;this.menu.append(title);
    for(const [name,fn,disabled] of [['在此添加关键帧',()=>this.add(frame,q.group),t.kind!=='dynamic'],['删除选中关键帧',()=>this.remove(),!this.refs.length],['复制关键帧',()=>this.copy(),!this.refs.length],['从此帧粘贴',()=>this.paste(frame),!this.clipboard.length||t.kind!=='dynamic'],['线性',()=>this.preset('linear'),!this.refs.length],['保持 / 瞬间切换',()=>this.preset('hold'),!this.refs.length],['缓入缓出 F9',()=>this.preset('ease'),!this.refs.length||this.refs.some(r=>r.p==='shape')]]){const b=document.createElement('button');b.textContent=name;b.disabled=disabled||e.node.busy;b.setAttribute('role','menuitem');b.onclick=()=>{this.menu.hidden=true;fn();};this.menu.append(b);}this.menu.hidden=false;const box=this.menu.getBoundingClientRect(),button=this.$('[data-more]').getBoundingClientRect();this.menu.style.left=`${clamp(ev?.clientX??button.left,6,window.innerWidth-box.width-6)}px`;this.menu.style.top=`${clamp(ev?.clientY??button.top,6,window.innerHeight-box.height-6)}px`;this.menu.querySelector('button:not(:disabled)')?.focus();
  }
  renderDetail(){this.detail.replaceChildren();const e=this.e,t=this.read();this.detail.hidden=!this.groups().length;if(!this.refs.length&&e.tool!=='path'){const hint=document.createElement('span');hint.textContent=`S 为已勾选属性设键 · 拖动移键 · 在空白处拖出选框，按住 Shift 可从关键帧上框选 · Delete 删除 · 滚轮缩放 · 中键平移`;this.detail.append(hint);}const button=(name,fn)=>{const b=document.createElement('button');b.textContent=name;b.onclick=fn;b.disabled=e.node.busy;this.detail.append(b);};
    if(e.tool==='path')for(const [name,fn] of [['尖角',()=>e.pathEditor.corner(false)],['平滑点',()=>e.pathEditor.corner(true)],['删点',()=>e.pathEditor.remove()],['矩形',()=>e.pathEditor.preset('rectangle')],['椭圆',()=>e.pathEditor.preset('ellipse')]])button(name,fn);if(!this.refs.length||!t)return;const label=document.createElement('span');label.textContent=`已选 ${this.refs.length} 键`;this.detail.append(label);button('删除',()=>this.remove());for(const [name,p] of [['线性','linear'],['保持','hold'],['缓入','ease-in'],['缓出','ease-out'],['缓入缓出','ease']])if(!this.refs.some(r=>r.p==='shape')||['linear','hold'].includes(p))button(name,()=>this.preset(p));
    if(this.refs.length===1){const ref=this.refs[0],key=channel(t,ref.p).keys.find(k=>k.frame===ref.frame);for(const [name,value,fn] of [['帧',ref.frame+1,v=>this.selected(moveKeys(e.track(),[ref],Math.round(v)-1-ref.frame,e.node.document.source.frames))],...(ref.p==='shape'?[]:[['数值',+(key.value*this.factor(ref.p)).toFixed(3),v=>putKey(e.track(),ref.p,ref.frame,v/this.factor(ref.p))]])]){const l=document.createElement('label');l.textContent=name;const input=document.createElement('input');input.type='number';input.step='any';input.value=value;input.setAttribute('aria-label',`关键帧${name}`);this.bind(input,()=>e.edit(()=>fn(Number(input.value))));l.append(input);this.detail.append(l);}}
  }
  zoom(factor,center=(this.range[0]+this.range[1])/2){const total=this.e.node.document.source.frames-1,span=clamp((this.range[1]-this.range[0])*factor,Math.min(3,total),total),ratio=(center-this.range[0])/Math.max(1,this.range[1]-this.range[0]),lo=clamp(center-span*ratio,0,total-span);this.range=[lo,lo+span];}
  panRange(delta){const total=this.e.node.document.source.frames-1,span=this.range[1]-this.range[0],lo=clamp(this.range[0]+delta,0,total-span);this.range=[lo,lo+span];}
  fit(selected=false){const total=this.e.node.document.source.frames-1;if(selected&&this.refs.length){const lo=Math.min(...this.refs.map(r=>r.frame)),hi=Math.max(...this.refs.map(r=>r.frame)),pad=Math.max(2,(hi-lo)*.12);this.range=[Math.max(0,lo-pad),Math.min(total,hi+pad)];if(this.graph&&this.e.property!=='shape'){const t=this.read(),v=this.refs.filter(r=>r.p===this.e.property).map(r=>channel(t,r.p).keys.find(k=>k.frame===r.frame).value);if(v.length){const a=Math.min(...v),b=Math.max(...v),p=Math.max((b-a)*.15,1/this.factor());this.bounds=[a-p,b+p];}}}else{this.range=[0,total];this.bounds=null;}this.render();}
  close(){this.observer.disconnect();}
}

