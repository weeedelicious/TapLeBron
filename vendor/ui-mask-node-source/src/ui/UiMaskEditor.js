import { enterEditorModal, startEditorGesture, cancelEditorGesture, hasEditorGesture, isTextInput } from './EditorInteraction.js';
import { activeAt, boxAt, frameAt, makeTrack, validateMaskDocument, poseAt, ensureAbsolute, ensureTrackChannels, setTrackPose, changeTrackKind, trackPolygon, polygonSpans } from '../skills/UiMaskDocument.js';
import { scalarAt, setChannelKey, deleteChannelKey, moveChannelKey, PROPERTY_NAMES } from '../skills/UiMaskAnimation.js';
import { UiMaskCurvePanel } from './UiMaskAdaptivePanel.js';
import { UiMaskPathEditor } from './UiMaskPathEditor.js';
import { UiMaskPathDrawing } from './UiMaskPathDrawing.js';
import { UiMaskViewport } from './UiMaskViewport.js';
import { videoPoint } from './UiMaskPathGeometry.js';
import { assignMaskNumbers, maskDisplayId, opacityAt, pathAt, isRectanglePath } from '../skills/UiMaskAppearance.js';
// Shotflow：样式由 public/ui-mask-bridge.js 用 <link> 加载（浏览器不能直接 import .css）
import { resizeMaskBox, numericMaskBox } from './UiMaskGeometry.js';
import { marqueeIds, combineSelection, translateSelection } from './UiMaskSelection.js';
import { UiMaskSeekPlayback } from './UiMaskSeekPlayback.js';
import { UiMaskModelLayer } from './UiMaskModelLayer.js';
import { randomUUID } from '../utils/randomUUID.js';
import { localRequest } from '../utils/LocalVideo.js';
import { trimOpacityRange } from './opacityClip.js';
import { mergeMaskTracks } from './UiMaskMerge.js';

export class UiMaskEditor {
  constructor(node){
    assignMaskNumbers(node.document);
    this.node=node;this.category=node.getParam('outputCategory');this.frame=0;this.selected=null;this.selectedKey=null;this.keyFocus=false;this.property='x';this.history=[];this.redo=[];this.zoom=1;this.tool='select';this.timelineZoom=1;
    this.dialog=document.createElement('dialog');this.dialog.className='ui-mask-editor';
    this.dialog.setAttribute('aria-label','遮罩创作工作台');
    this.dialog.innerHTML=`<header><div class="ui-mask-title"><strong>遮罩创作工作台</strong><span data-view="source"></span></div><div class="ui-mask-row"><button data-action="focus" hidden aria-pressed="false" title="收起属性与时间轴，最大化画面（Tab）">专注画面 Tab</button><button data-action="save" hidden>保存草稿</button><button data-action="close" hidden>保存并关闭</button></div></header>
      <div class="ui-mask-toolbar" role="toolbar" aria-label="画面工具"><div class="ui-mask-tool-group"><button data-action="select" aria-pressed="true">选择 V</button><button data-action="add" aria-pressed="false">矩形 R</button><button data-action="pen" aria-pressed="false">钢笔 G</button><button data-action="path-handles" aria-pressed="false" title="W 开 / 关：在选中遮罩的轮廓边缘单击加点">添加锚点 W</button><button data-action="point-delete" hidden title="Delete 删除选中锚点；Shift+Delete 删除整块遮罩">删除锚点</button><button data-action="path-finish" hidden>完成轮廓 Enter</button><button data-action="pan" hidden aria-pressed="false">平移 H</button><button data-action="center" hidden title="无需拖动，先创建矩形，再用变换数值微调">居中添加 C</button></div><div class="ui-mask-tool-group" hidden><button data-action="undo" title="Ctrl+Z">撤销</button><button data-action="redo" title="Ctrl+Shift+Z">重做</button></div><div class="ui-mask-tool-group"><button data-action="zoom-out" hidden aria-label="缩小画面">−</button><button data-action="fit" hidden data-view="zoom" title="适应画面（F）">适应</button><button data-action="zoom-in" hidden aria-label="放大画面">＋</button><button data-action="actual" hidden>1:1</button></div><label><input type="checkbox" data-field="overlay" checked>覆盖预览</label><label class="ui-mask-opacity">浓度 <input type="range" data-field="opacity" min="0" max="100" value="70" aria-label="覆盖预览浓度"></label><span class="ui-mask-tool-group ui-mask-merge-group"><button data-action="merge" title="M：先选中多个遮罩（空白处拖框 / Shift 点选），再点合并">合并 M</button></span><button data-action="help" hidden aria-expanded="false">快捷键 ?</button></div>
      <div class="ui-mask-shortcuts" data-view="shortcuts" hidden>R 画矩形 · V 选择 · H / 中键平移 · F 适应画面 · 滚轮缩放 · S 为「显示属性」中勾选的属性设键 · ← → 逐帧 · Space 播放 · Delete 删除 · Ctrl+D 复制遮罩 · Ctrl+Z 撤销 · Esc 退出绘制。半透明仅用于预览，输出始终为纯黑遮罩。</div>
      <div class="ui-mask-workspace"><main><div class="ui-mask-view-hint"><strong data-view="tool">选择工具</strong><span data-view="hint" role="status"></span></div><div class="ui-mask-stage"><div class="ui-mask-surface"><canvas aria-label="遮罩画面：拖动绘制或移动，角点缩放，圆点旋转" aria-haspopup="menu" tabindex="0"></canvas></div></div><div class="ui-mask-transport"><button data-action="first" title="第一帧">|‹</button><button data-action="previous" title="上一帧">‹</button><button data-action="play">播放</button><button data-action="next" title="下一帧">›</button><button data-action="last" title="最后一帧">›|</button><input data-field="seek" aria-label="播放进度" type="range" min="0" value="0"><label>帧 <input data-field="frame" type="number" min="1" aria-label="当前帧"></label><span data-view="time"></span><select data-field="speed" aria-label="播放速度"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select><label><input type="checkbox" data-field="loop">循环</label></div>
      <section class="ui-mask-keyframes" data-view="keyframes"><div class="ui-mask-timeline-resizer" role="separator" aria-label="调整时间轴高度" aria-orientation="horizontal" tabindex="0"></div><div class="ui-mask-key-actions"><strong>动画</strong><label><input type="checkbox" data-field="auto-key" checked>自动 K</label><button data-action="key-previous" title="上一关键帧">‹◆</button><button data-action="key-add">设键 S</button><button data-action="key-next" title="下一关键帧">◆›</button><button data-action="key-delete">删键</button><label>选中键 <input type="number" data-field="key-frame" min="1" aria-label="选中键所在帧"></label><label class="ui-mask-timeline-zoom">时间轴 <input type="range" data-field="timeline-zoom" min="1" max="8" step="0.5" value="1" aria-label="时间轴缩放"></label></div><div class="ui-mask-timeline-scroll"><div class="ui-mask-timeline" data-view="keys" aria-label="所选遮罩的关键帧轨道"></div></div><div class="ui-mask-key-caption" data-view="key-caption"></div></section></main>
      <div class="ui-mask-inspector-resizer" role="separator" aria-label="调整属性栏宽度" aria-orientation="vertical" tabindex="0"></div><aside><div class="ui-mask-category"><strong data-view="category"></strong><select data-field="category" aria-label="当前编辑与输出类别"><option value="static">静态 UI</option><option value="dynamic">动态 UI</option></select></div><div class="ui-mask-row"><button data-action="enable">全部启用</button><button data-action="disable">全部停用</button><button data-action="duplicate">复制</button><button data-action="delete">删除</button></div><select data-field="tracks" size="5" aria-label="UI遮罩列表"></select>
      <div class="ui-mask-tabs" role="tablist" aria-label="遮罩属性"><button role="tab" aria-selected="true" data-tab="transform">对象与变换</button><button role="tab" aria-selected="false" data-tab="timing">时段与输出</button></div>
      <div class="ui-mask-inspector-body"><section data-view="selection"><div data-panel="transform"><div class="ui-mask-row"><label>名称<input data-field="label" maxlength="100"></label><label class="ui-mask-enabled"><input data-field="enabled" type="checkbox">启用</label></div><div class="ui-mask-row"><label>对象类别<select data-field="kind"><option value="static">静态 UI</option><option value="dynamic">动态 UI</option></select></label><label>旋转角度（度）<input data-field="angle" type="number" step="1" min="-36000" max="36000"></label></div><div class="ui-mask-row"><label>X（px）<input data-field="x" type="number" min="0" step="1"></label><label>Y（px）<input data-field="y" type="number" min="0" step="1"></label></div><div class="ui-mask-row"><label>宽度（px）<input data-field="width" type="number" min="1" step="1"></label><label>高度（px）<input data-field="height" type="number" min="1" step="1"></label></div><label data-view="interpolation">关键帧插值<select data-field="interpolation"><option value="linear">线性</option><option value="hold">保持 / 跳变</option></select></label><p class="ui-mask-note" data-view="selection-hint"></p></div>
      <div data-panel="timing" hidden><label>出现时段<select data-field="range"></select></label><div class="ui-mask-row"><label>出现帧<input data-field="first" type="number" min="1"></label><label>结束帧（含）<input data-field="last" type="number" min="1"></label></div><div class="ui-mask-row"><button data-action="start">此帧出现</button><button data-action="end">此帧起消失</button></div><div class="ui-mask-row"><button data-action="range-add">添加时段</button><button data-action="range-delete">删除时段</button></div><button data-action="locate">跳到出现帧</button></div></section>
      <p class="ui-mask-note" data-view="empty" hidden>这一类还没有遮罩。选择「钢笔」逐点勾画，拖动拉出曲线，Enter 闭合；也可选「矩形」。</p><div data-panel="timing" hidden><fieldset data-view="mode"><legend>动态覆盖方式</legend><label><input type="radio" name="ui-mask-mode" value="follow">跟随当前 UI</label><label hidden><input type="radio" name="ui-mask-mode" value="trail">覆盖完整移动轨迹</label></fieldset><p class="ui-mask-note">当前类别单独输出，另一类草稿会保留。预览浓度不影响输出：遮罩区域为纯黑，原音频保留。</p><div class="ui-mask-results" data-view="results"></div></div></div></aside></div>
      <footer><div><span data-view="summary"></span><p data-view="status" role="status">修改会自动保存</p></div><div class="ui-mask-row"><button data-action="cancel-job" hidden>取消生成</button><button class="ui-mask-primary" data-action="generate" hidden>生成黑色遮罩视频</button></div></footer>
      <div class="ui-mask-context-menu" role="menu" aria-label="遮罩操作" hidden><button type="button" role="menuitemradio" data-mask-choice="static">设为静态</button><button type="button" role="menuitemradio" data-mask-choice="dynamic">设为动态</button><hr><button type="button" role="menuitem" data-mask-choice="remove">移除</button><button type="button" role="menuitem" data-mask-choice="confirm">确认</button></div>`;
    this.$=s=>this.dialog.querySelector(s);this.field=name=>this.$(`[data-field="${name}"]`);
    this.canvas=this.$('canvas');this.ctx=this.canvas.getContext('2d');this.video=document.createElement('video');
    this.contextMenu=this.$('.ui-mask-context-menu');
    this.applyCategory();
    this.video.muted=true;this.video.playsInline=true;this.video.preload='auto';this.video.src=`/api/ui-mask/jobs/${node.maskTask.id}/source`;
    const s=node.document.source;this.canvas.width=s.width;this.canvas.height=s.height;
    this.videoFrame=document.createElement('canvas');this.videoFrame.width=s.width;this.videoFrame.height=s.height;this.videoFrameContext=this.videoFrame.getContext('2d');
    if(!this.video.requestVideoFrameCallback)this.seekPlayback=new UiMaskSeekPlayback(this.video,s,{onFrame:frame=>this.commitVideoFrame(frame),onState:()=>{if(!this.closed)this.renderTransport();}});
    this.dialog.dataset.previewVersion='20261024-indexed-seek';
    this.dialog.dataset.previewMode=this.seekPlayback?'indexed-seek':'presented-frame';
    this.$('[data-view="source"]').textContent=`${s.width} × ${s.height} · ${s.frames} 帧`;
    this.field('frame').max=s.frames;
    this.field('seek').max=s.frames-1;this.field('seek').step=1;
    this.abort=new AbortController();const signal=this.abort.signal;
    const actions={close:()=>this.saveAndClose(),save:()=>node.flushDocument().then(()=>this.status('草稿已保存')).catch(e=>this.status(`保存失败：${e.message}`)),play:()=>this.toggle(),previous:()=>this.stepFrame(-1),next:()=>this.stepFrame(1),first:()=>this.seek(0),last:()=>this.seek(s.frames-1),
      select:()=>this.setTool('select'),pen:()=>this.setTool('pen'),merge:()=>this.mergeSelected(),'path-handles':()=>this.pathEditor.toggleAddMode(),'point-delete':()=>this.pathEditor.remove(),'path-finish':()=>this.pathDrawing.finish(),pan:()=>this.setTool('pan'),center:()=>this.createCentered(),duplicate:()=>this.duplicate(),
      focus:()=>this.toggleFocus(),help:()=>{const help=this.$('[data-view="shortcuts"]');help.hidden=!help.hidden;this.$('[data-action="help"]').setAttribute('aria-expanded',String(!help.hidden));},locate:()=>this.seek(this.track()?.ranges[Number(this.field('range').value)]?.[0]??0),
      add:()=>this.add(this.category),delete:()=>this.deleteSelection(),
      undo:()=>this.undo(),redo:()=>this.redoEdit(),enable:()=>this.edit(()=>this.visibleTracks().forEach(t=>t.enabled=true)),disable:()=>this.edit(()=>this.visibleTracks().forEach(t=>t.enabled=false)),
      start:()=>this.changeRange('start'),end:()=>this.changeRange('end'),'range-add':()=>this.addRange(),'range-delete':()=>this.edit(()=>this.track()?.ranges.splice(Number(this.field('range').value),1)),
      'key-add':()=>this.addKey(),'key-delete':()=>this.deleteKey(),'key-previous':()=>this.jumpKey(-1),'key-next':()=>this.jumpKey(1),
      'zoom-in':()=>this.setZoom(this.zoom*1.25),'zoom-out':()=>this.setZoom(this.zoom/1.25),fit:()=>this.setZoom(1),actual:()=>this.setZoom(1,undefined,'actual'),generate:()=>{this.video.pause();this.setTool('select');node.generate();},'cancel-job':()=>node.cancel()};
    for(const b of this.dialog.querySelectorAll('[data-action]'))b.onclick=()=>actions[b.dataset.action]();
    this.field('overlay').onchange=()=>this.draw();
    this.field('opacity').oninput=()=>this.draw();
    this.field('category').onchange=e=>node.setParam('outputCategory',e.target.value);
    this.field('speed').onchange=e=>{this.video.playbackRate=Number(e.target.value);};
    this.field('loop').onchange=e=>{this.video.loop=e.target.checked;};
    this.field('frame').onchange=e=>this.seek(Number(e.target.value)-1);
    this.field('timeline-zoom').oninput=e=>{this.timelineZoom=Number(e.target.value);this.renderKeys();};
    for(const name of ['x','y','width','height'])this.field(name).onchange=this.field(name).onblur=()=>this.transformNumber(name);
    for(const button of this.dialog.querySelectorAll('[data-tab]'))button.onclick=()=>this.showPanel(button.dataset.tab);
    this.setupSplitters();
    this.$('.ui-mask-stage').addEventListener('wheel',e=>{e.preventDefault();this.setZoom(this.zoom*(e.deltaY<0?1.15:1/1.15),[e.clientX,e.clientY]);},{signal,passive:false});
    this.$('.ui-mask-stage').addEventListener('pointerdown',e=>{if(e.target===this.canvas)return;if(['select','path','pen'].includes(this.tool)){this.pointer(e);return;}if(this.tool==='pan'||e.button===1)this.pan(e);else if(this.tool==='select'&&e.button===0)this.marquee(e);else if(this.tool==='draw')this.hint('请在视频画面内按住左键拖动，四周留白不是视频内容。');},{signal});
    this.field('auto-key').closest('label').remove();
    this.field('key-frame').onchange=this.field('key-frame').onblur=e=>{const frame=Number(e.target.value)-1;if(e.target.value!==''&&frame!==this.selectedKey)this.moveKey(frame);};
    this.field('tracks').onchange=()=>{this.setTool('select');this.selected=this.field('tracks').value;this.selectedKey=null;this.keyFocus=false;this.render();const t=this.track();if(t&&!activeAt(t,this.frame))this.seek(t.ranges[0]?.[0]??0);};
    this.field('enabled').onchange=e=>this.edit(()=>{const t=this.track();if(t)t.enabled=e.target.checked;});
    this.field('label').onchange=e=>this.edit(()=>{const t=this.track();if(t)t.label=e.target.value.trim()||'UI遮罩';});
    this.field('kind').onchange=e=>this.changeKind(e.target.value);
    this.field('angle').onchange=this.field('angle').onblur=e=>{const t=this.track();if(!t||e.target.value==='')return;const angle=Number(e.target.value);if(angle===poseAt(t,this.frame).angle)return;if(!this.canTransform(t)){this.renderTransport();return;}this.property='angle';this.edit(()=>{if(t.kind==='dynamic')ensureTrackChannels(t);setTrackPose(t,this.frame,{box:poseAt(t,this.frame).box,angle});this.selectedKey=t.kind==='dynamic'?this.frame:null;});};
    this.$('[data-view="interpolation"]').remove();
    this.field('range').onchange=()=>this.renderRange();
    for(const key of ['first','last'])this.field(key).onchange=()=>this.edit(()=>{const t=this.track(),i=Number(this.field('range').value);if(!t?.ranges[i])return;const frame=key==='first'?Number(this.field('first').value)-1:Number(this.field('last').value);t.ranges=trimOpacityRange(t.ranges,i,key==='first'?'start':'end',frame,this.node.document.source.frames);});
    for(const radio of this.dialog.querySelectorAll('[name="ui-mask-mode"]')){radio.checked=radio.value===node.getParam('dynamicMode');radio.onchange=()=>{node.setParam('dynamicMode',radio.value);this.rebuildUnion();};}
    this.field('seek').oninput=e=>this.seek(Number(e.target.value));
    // Commit typed values on Enter or blur as well as native change. Keep an
    // explicit dirty flag so merely focusing a rounded pixel value adds no key.
    for(const name of ['label','frame','angle','key-frame','first','last','x','y','width','height']){
      const input=this.field(name),commit=input.onchange;
      input.oninput=()=>{input.dataset.edited='true';};
      input.onchange=input.onblur=e=>{if(!input.dataset.edited)return;delete input.dataset.edited;commit(e);};
      input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();input.onchange(e);input.blur();}};
    }
    this.canvas.addEventListener('pointerdown',e=>this.pointer(e),{signal});
    this.canvas.addEventListener('contextmenu',e=>{
      e.preventDefault();e.stopPropagation();this.hideContextMenu();
      if(this.video.seeking||this.video.readyState<2)return;
      this.openContextMenu(this.hitTrack(this.point(e),true),e.clientX,e.clientY);
    },{signal});
    this.canvas.addEventListener('keydown',e=>{
      if(e.key!=='ContextMenu'&&!(e.shiftKey&&e.key==='F10'))return;
      e.preventDefault();e.stopPropagation();const t=this.track(),b=t&&boxAt(t,this.frame),r=this.canvas.getBoundingClientRect();
      if(b)this.openContextMenu(t,r.left+(b[0]+b[2])*r.width/2,r.top+(b[1]+b[3])*r.height/2);
    },{signal});
    for(const button of this.contextMenu.querySelectorAll('button'))button.onclick=()=>{
      const choice=button.dataset.maskChoice;this.hideContextMenu(true);
      if(['static','dynamic'].includes(choice)){this.changeKind(choice,true);return;}
      this.setSelectionEnabled(choice==='confirm');
    };
    this.contextMenu.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();},{signal});
    this.contextMenu.addEventListener('keydown',e=>{
      if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();const buttons=[...this.contextMenu.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();}
    },{signal});
    this.dialog.addEventListener('pointerdown',e=>{if(!this.contextMenu.contains(e.target))this.hideContextMenu();},{signal,capture:true});
    this.dialog.addEventListener('wheel',()=>this.hideContextMenu(),{signal,passive:true});
    window.addEventListener('resize',()=>this.hideContextMenu(),{signal});
    this.dialog.addEventListener('cancel',e=>{e.preventDefault();if(!this.contextMenu.hidden)this.hideContextMenu(true);else if(this.tool!=='select')this.setTool('select');else if(this.selectedIds.size){this.selectTracks([]);this.render();}else if(this.focusMode)this.toggleFocus();else this.saveAndClose();},{signal});
    this.dialog.addEventListener('keydown',e=>{
      e.stopPropagation();
      if(e.key==='Escape'&&this.selectionMenu?.open){e.preventDefault();this.selectionMenu.open=false;this.canvas.focus({preventScroll:true});return;}
      if(!this.contextMenu.hidden){
        if(e.key==='Escape'){e.preventDefault();this.hideContextMenu(true);return;}
        if(e.key==='Tab')this.hideContextMenu(true);
        else if(this.contextMenu.contains(e.target))return;
      }
      if(isTextInput(e.target)||hasEditorGesture())return;
      if(e.key==='Escape'&&!this.curvePanel?.menu.hidden){e.preventDefault();this.curvePanel.menu.hidden=true;return;}
      if(this.pathDrawing?.keydown(e)){e.preventDefault();return;}
      if(this.curvePanel?.keydown(e)){e.preventDefault();return;}
      if(this.pathEditor?.keydown(e)){e.preventDefault();return;}
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();this.selectScope(e.shiftKey?'clear':'all');}
      else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='i'){e.preventDefault();this.selectScope('invert');}
      else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?this.redoEdit():this.undo();}
      else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='d'){e.preventDefault();this.duplicate();}
      else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();actions.save();}
      else if(!e.ctrlKey&&!e.metaKey&&!e.altKey&&['v','r','g','h','f','c','m','?'].includes(e.key.toLowerCase())){e.preventDefault();const key=e.key.toLowerCase();({v:actions.select,r:actions.add,g:actions.pen,m:actions.merge,h:actions.pan,f:actions.fit,c:actions.center,'?':actions.help})[key]();}
      else if(e.key==='Tab'&&e.target===this.canvas){e.preventDefault();this.toggleFocus();}
      else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();e.shiftKey?actions.delete():this.keyFocus?this.deleteKey():actions.delete();}
      else if(e.key.toLowerCase()==='s'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();this.addKey();}
      else if(e.key==='F9'){e.preventDefault();this.curvePanel.preset('ease');}
      else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();this.stepFrame(e.key==='ArrowLeft'?-1:1);}
      else if(e.key==='F2'){e.preventDefault();this.settingsButton?.click();}
      else if(e.code==='Space'&&!e.target.closest('button')){e.preventDefault();this.toggle();}
    },{signal});
    for(const event of ['mousedown','pointerdown','click'])this.dialog.addEventListener(event,e=>e.stopPropagation(),{signal});
    for(const event of ['loadeddata','seeked','timeupdate','pause','play','ended'])this.video.addEventListener(event,()=>{
      this.videoEvent(event);
    },{signal});
    if(this.video.requestVideoFrameCallback){const watch=(_,m)=>{if(this.closed)return;this.presentVideoFrame(m.mediaTime);this.callback=this.video.requestVideoFrameCallback(watch);};this.callback=this.video.requestVideoFrameCallback(watch);}
    this.video.addEventListener('seeking',()=>this.renderTool(),{signal});
    this.video.addEventListener('error',()=>{this.hint('视频读取失败，请保存草稿并重新打开。');this.status('视频读取失败，请保存草稿并重新打开。');},{signal});
    document.body.appendChild(this.dialog);this.release=enterEditorModal(this.dialog);this.dialog.showModal();
    this.setupObjectBar();this.pathEditor=new UiMaskPathEditor(this);this.canvas.addEventListener('pointermove',ev=>{this.pathEditor.hover(ev);this.scaleHover(ev);});this.pathDrawing=new UiMaskPathDrawing(this);this.viewport=new UiMaskViewport(this);
    this.curvePanel=new UiMaskCurvePanel(this);
    this.resizeObserver=new ResizeObserver(()=>{this.setZoom(this.zoom,undefined,this.zoomMode);this.renderKeys();});this.resizeObserver.observe(this.$('.ui-mask-stage'));
    if(node.document.modelBase)this.modelLayer=new UiMaskModelLayer(this);
    this.selected=this.visibleTracks()[0]?.id;this.render();this.rebuildUnion();this.video.load();this.setZoom(1);this.renderTool();
  }
  setupObjectBar(){
    const bar=document.createElement('div');bar.className='mask-object-bar';
    bar.innerHTML='<label>遮罩</label><input type="search" aria-label="筛选遮罩编号或名称" placeholder="筛选 ID / 名称"><label class="mask-inspect"><input type="checkbox">查看属性</label><span class="mask-spacer"></span><button type="button" hidden aria-expanded="false">遮罩设置 ⋯</button>';
    this.$('.ui-mask-workspace').before(bar);const list=this.field('tracks');list.removeAttribute('size');bar.children[0].append(list);bar.prepend(this.field('category'));
    const selectionMenu=this.selectionMenu=document.createElement('details');selectionMenu.className='mask-selection-menu';selectionMenu.innerHTML='<summary>选择 ⋯ <span data-selection-count></span></summary><div></div>';bar.querySelector('.mask-spacer').before(selectionMenu);
    this.dialog.addEventListener('pointerdown',ev=>{if(!selectionMenu.contains(ev.target))selectionMenu.open=false;},{signal:this.abort.signal});
    for(const [label,fn] of [['全选当前帧 Ctrl+A',()=>this.selectScope('all')],['反选当前帧 Ctrl+I',()=>this.selectScope('invert')],['取消选择 Esc',()=>this.selectScope('clear')],['复制选中 Ctrl+D',()=>this.duplicate()],['删除选中 Delete',()=>this.deleteSelection()],['停用选中',()=>this.setSelectionEnabled(false)],['启用选中',()=>this.setSelectionEnabled(true)]]){const b=document.createElement('button');b.textContent=label;b.onclick=()=>{selectionMenu.open=false;fn();this.canvas.focus({preventScroll:true});};selectionMenu.lastChild.append(b);}
    for(const [label,fn] of [['复制选中',()=>this.duplicate()],['删除选中',()=>this.deleteSelection()],['全选当前帧',()=>this.selectScope('all')],['反选当前帧',()=>this.selectScope('invert')],['取消选择',()=>this.selectScope('clear')]]){const b=document.createElement('button');b.textContent=label;b.type='button';b.setAttribute('role','menuitem');b.dataset.selectionAction=label;b.onclick=()=>{this.hideContextMenu(true);fn();};this.contextMenu.append(b);}
    this.maskSearch=bar.querySelector('[type=search]');this.maskSearch.oninput=()=>this.render();this.inspectToggle=bar.querySelector('[type=checkbox]');this.inspectToggle.onchange=()=>this.curvePanel.inspect(this.inspectToggle.checked);
    const settings=this.settingsButton=bar.querySelector(':scope > button');settings.onclick=()=>{const on=this.dialog.classList.toggle('mask-settings-open');settings.setAttribute('aria-expanded',String(on));};
    this.dialog.addEventListener('pointerdown',ev=>{if(!ev.target.closest('aside')&&!settings.contains(ev.target)){this.dialog.classList.remove('mask-settings-open');settings.setAttribute('aria-expanded','false');}},{signal:this.abort.signal});
    this.$('.ui-mask-stage').addEventListener('dblclick',ev=>this.doubleClickMask(ev),{signal:this.abort.signal});
    this.$('[data-view=shortcuts]').textContent='V 选择：空白处左键框选 · Shift 点击切换 / 拖框追加 · Alt 减选 · Ctrl 拖框（可从遮罩内部开始） · Ctrl+A 全选当前帧 · Ctrl+I 反选 · Esc 取消选择 · 拖动选中项整体移动 · 拖动锚点编辑 · 拖动边缘整条边移动 · Alt 拖锚点拉曲线 · W 添加锚点（边缘单击加点） · 中键轻点边缘加点 · Delete 删锚点 / 未选锚点时删遮罩 · Shift+Delete 删遮罩 · Ctrl+D 复制选中 · Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · C 居中添加 · R 矩形 · G 钢笔（单击加点，拖动拉曲线，Enter 闭合） · M 合并（先选中多个遮罩，再点合并） · H / 中键平移 · F 适应画面 · S 为「显示属性」中勾选的属性设键 · ← → 逐帧 · Tab 专注画面 · Ctrl+S 保存草稿 · Esc 退出当前操作，最后保存并关闭 · F2 遮罩设置。多选时属性区只编辑主选遮罩。';
    for(const p of this.dialog.querySelectorAll('aside .ui-mask-note'))if(p.textContent.includes('纯黑'))p.textContent='当前类别单独输出，另一类草稿保留。属性不透明度会写入输出，原音频保留。';
    this.layoutStudio();
  }
  layoutStudio(){
    const dialog=this.dialog;
    const top=document.createElement('div');top.className='ui-mask-topbar';
    const tools=document.createElement('div');tools.className='ui-mask-top-tools';
    const title=dialog.querySelector('.ui-mask-title strong');if(title)top.append(title);
    const toolbar=dialog.querySelector('.ui-mask-toolbar');while(toolbar?.firstChild)tools.append(toolbar.firstChild);toolbar?.replaceWith(top);
    // Shotflow：画面工具挪到画面下方、时间轴上面，顶栏只留标题和关闭
    const bottom=document.createElement('div');bottom.className='ui-mask-topbar ui-mask-bottombar';bottom.append(tools);
    const close=document.createElement('button');close.type='button';close.className='ui-mask-close';close.textContent='×';close.title='关闭当前窗口';close.setAttribute('aria-label','关闭当前窗口');close.onclick=()=>this.saveAndClose();top.append(close);
    dialog.querySelector('header')?.setAttribute('hidden','');
    const side=document.createElement('div');side.className='ui-mask-studio-side';
    const output=document.createElement('label');output.textContent='当前输出';output.append(this.field('category'));
    const coverLabel=document.createElement('label');coverLabel.textContent='动态覆盖';
    const cover=document.createElement('select');cover.innerHTML='<option value="follow">跟随覆盖</option>';cover.value='follow';cover.setAttribute('aria-label','动态覆盖');cover.onchange=()=>{this.node.setParam('dynamicMode',cover.value);for(const radio of dialog.querySelectorAll('[name="ui-mask-mode"]'))radio.checked=radio.value===cover.value;this.rebuildUnion();};coverLabel.append(cover);this.dynamicCoverSelect=cover;this.dynamicCoverLabel=coverLabel;
    const kindLabel=document.createElement('label');kindLabel.textContent='类别';
    const kind=document.createElement('select');kind.innerHTML='<option value="static">静态 UI</option><option value="dynamic">动态 UI</option>';kind.setAttribute('aria-label','类别');kind.onchange=()=>this.changeKind(kind.value);kindLabel.append(kind);this.kindMirror=kind;
    const colorLabel=document.createElement('label');colorLabel.textContent='遮罩颜色';
    const color=document.createElement('select');color.innerHTML='<option value="black">黑</option><option value="red">红</option><option value="green">绿</option><option value="blue">蓝</option>';color.value=this.node.coverColor||'green';color.setAttribute('aria-label','遮罩颜色');color.onchange=()=>{this.node.coverColor=color.value;};colorLabel.append(color);
    const confirm=document.createElement('button');confirm.type='button';confirm.className='ui-mask-generate';confirm.textContent='输出';confirm.onclick=()=>this.node.generate();
    const again=document.createElement('button');again.type='button';again.className='ui-mask-regenerate';again.textContent='自动生成遮罩';again.onclick=()=>this.regenerateMasks();
    const job=document.createElement('div');job.className='ui-mask-job';job.hidden=true;job.innerHTML='<progress max="100" value="0"></progress><p data-view="job-text"></p>';
    side.append(output,coverLabel,kindLabel,colorLabel,again,confirm,job);this.jobView=job;
    const workspace=dialog.querySelector('.ui-mask-workspace');workspace.prepend(side);
    const transport=dialog.querySelector('.ui-mask-transport'),keys=dialog.querySelector('.ui-mask-keyframes');
    workspace.after(bottom);if(transport&&keys)bottom.after(transport,keys);
    dialog.querySelector('.mask-object-bar')?.classList.add('ui-mask-object-bar-hidden');
  }
  async regenerateMasks(){
    if(this.node.busy)return;
    this.edit(()=>{this.node.document.tracks=[];this.selected=null;});
    try{await this.node.flushDocument();}catch(error){this.status(error.message);return;}
    this.node.analyze('detect',{keepEditor:true});
  }
  async reloadShared(){
    const id=this.node.maskTask?.id;if(!id){this.status('还没有可刷新的遮罩稿');return;}
    try{
      const job=await localRequest(`/api/ui-mask/jobs/${id}`);
      if(!job.document){this.status(job.message||'遮罩稿还没准备好');return;}
      this.node.document=validateMaskDocument(job.document);this.selected=null;this.render();this.rebuildUnion();this.status('已刷新共享遮罩稿');
    }catch(error){this.status(error.message);}
  }
  get selected(){return this._selected;}
  doubleClickMask(ev){
    ev.preventDefault();ev.stopPropagation();
    if(this.node.busy||this.video.seeking||this.video.readyState<2)return;
    if(this.tool==='path'){this.pathEditor.insert(this.point(ev,false));return;}
    if(this.tool!=='select'||ev.shiftKey||ev.altKey||ev.ctrlKey||ev.metaKey)return;
    const track=this.hitTrack(this.point(ev,false));
    if(!track)return;
    this.selected=track.id;this.render();this.curvePanel.inspect(true);
  }
  set selected(id){this._selected=id||null;this.selectedIds=new Set(id?[id]:[]);}
  selectTracks(ids,primary){
    const valid=new Set(this.visibleTracks().map(t=>t.id));this.selectedIds=new Set(ids.filter(id=>valid.has(id)));
    this._selected=this.selectedIds.has(primary)?primary:this.selectedIds.has(this._selected)?this._selected:[...this.selectedIds].at(-1)||null;
    this.selectedKey=null;this.keyFocus=false;
  }
  selectedTracks(){return this.visibleTracks().filter(t=>this.selectedIds.has(t.id));}
  selectScope(mode){const ids=this.visibleTracks().filter(t=>activeAt(t,this.frame)).map(t=>t.id);this.selectTracks(mode==='clear'?[]:mode==='invert'?ids.filter(id=>!this.selectedIds.has(id)):ids);this.render();}
  deleteSelection(){const ids=new Set(this.selectedIds);if(this.node.busy||!ids.size)return;this.edit(()=>{this.node.document.tracks=this.node.document.tracks.filter(t=>!ids.has(t.id));this.selectTracks([]);});this.status(`已删除 ${ids.size} 个遮罩 · Ctrl+Z 撤销`);}
  setSelectionEnabled(enabled){const tracks=this.selectedTracks();if(this.node.busy||!tracks.length)return;this.edit(()=>tracks.forEach(t=>t.enabled=enabled));this.status(`已${enabled?'启用':'停用'} ${tracks.length} 个选中遮罩 · Ctrl+Z 撤销`);}
  marquee(e){
    if(this.node.busy||this.video.seeking||this.video.readyState<2)return;this.video.pause();this.canvas.focus({preventScroll:true});this.keyFocus=false;
    const p=this.point(e),before=[...this.selectedIds],primary=this.selected,mode=e.altKey?'subtract':e.shiftKey?'add':'replace';let moved=false;
    const update=q=>{moved=Math.hypot(q.clientX-e.clientX,q.clientY-e.clientY)>3;const v=this.point(q);this.marqueeBox=[Math.min(p[0],v[0]),Math.min(p[1],v[1]),Math.max(p[0],v[0]),Math.max(p[1],v[1])];if(moved)this.selectTracks(combineSelection(before,marqueeIds(this.visibleTracks(),this.frame,this.node.document.source,this.marqueeBox),mode),primary);this.draw();};
    startEditorGesture(e,{element:this.canvas,scope:this.dialog,move:update,end:q=>{update(q);if(!moved&&mode==='replace')this.selectTracks([]);this.marqueeBox=null;this.render();this.status(`已选 ${this.selectedIds.size} 个遮罩 · Shift 追加 · Alt 减选 · Delete 删除`);},cancel:()=>{this.marqueeBox=null;this.selectTracks(before,primary);this.render();}});
  }
  // 合并：把当前选中的遮罩（至少两个，空白处拖框或 Shift 点选）合成一块，可 Ctrl+Z 撤销
  mergeSelected(){
    if(this.node.busy)return;this.video.pause();
    const visible=new Set(this.visibleTracks().map(t=>t.id)),ids=new Set([...this.selectedIds].filter(id=>visible.has(id)));
    if(ids.size<2){this.status(ids.size?'只选中了 1 个遮罩：先在空白处拖框或 Shift 点选多个，再点合并':'先选中要合并的遮罩（空白处拖框或 Shift 点选），再点合并');return;}
    let mergedId=null;
    this.edit(()=>{const tracks=this.node.document.tracks,members=tracks.filter(t=>ids.has(t.id));const merged=mergeMaskTracks(members,this.frame,this.node.document.source,(kind,box,frame)=>this.newTrack(kind,box,frame));const at=tracks.findIndex(t=>ids.has(t.id));this.node.document.tracks=tracks.filter(t=>!ids.has(t.id));this.node.document.tracks.splice(Math.max(0,at),0,merged);mergedId=merged.id;this.selectTracks([merged.id],merged.id);});
    if(mergedId){this.setTool('select');this.render();this.rebuildUnion?.();this.status(`已把 ${ids.size} 个遮罩合并成 1 个 · Ctrl+Z 撤销`);}
  }
  scaleHandleHit(ev){
    const t=this.track();if(this.tool!=='select'||this.selectedIds.size!==1||!t||!activeAt(t,this.frame))return null;
    const handles=this.handles(t);if(!handles)return null;const q=this.point(ev,false),r=this.canvas.getBoundingClientRect();
    const index=handles.scales.findIndex(c=>Math.hypot((q[0]-c[0])*r.width,(q[1]-c[1])*r.height)<12);
    return index>=0?{t,handles,index}:null;
  }
  scaleHover(ev){
    if(ev.buttons||this.scaling)return;const hit=this.scaleHandleHit(ev),hot=hit?hit.index:-1;
    if(hot!==(this.scaleHot??-1)){this.scaleHot=hot;this.draw();}
    // 左上 / 右下用 ↖↘，右上 / 左下用 ↗↙
    if(hit)this.canvas.style.cursor=hit.index%2===0?'nwse-resize':'nesw-resize';
  }
  // 等比缩放：按住某个角外的方块拖，对角那个角不动，靠近这个角的两条边一起按比例放大缩小；
  // 形状和旋转不变，不出画面
  scaleGesture(e){
    const hit=this.scaleHandleHit(e);if(!hit)return false;const {t,index,handles}=hit;
    if(!this.canTransform(t)||this.video.seeking||this.video.readyState<2)return true;
    this.canvas.focus({preventScroll:true});this.video.pause();this.keyFocus=false;
    const before=this.snapshot(),frame=this.frame,pose=poseAt(t,frame),b=boxAt(t,frame),W=this.canvas.width,H=this.canvas.height;
    // 像素坐标里算：固定点 = 对角；拖动点在原对角线上的投影决定缩放比例（旋转过的遮罩也成立）
    const hw=(b[2]-b[0])/2,hh=(b[3]-b[1])/2,px=v=>[v[0]*W,v[1]*H];
    const anchor=px(handles.corners[(index+2)%4]),corner=px(handles.corners[index]),diag=[corner[0]-anchor[0],corner[1]-anchor[1]],diagLen2=Math.max(1,diag[0]**2+diag[1]**2);
    const minScale=Math.max(4/(hw*2*W),4/(hh*2*H));
    const boxFor=k=>{const c=[anchor[0]+diag[0]*k/2,anchor[1]+diag[1]*k/2];return [c[0]/W-hw*k,c[1]/H-hh*k,c[0]/W+hw*k,c[1]/H+hh*k];};
    const inside=box=>box[0]>=0&&box[1]>=0&&box[2]<=1&&box[3]<=1;
    let moved=false;this.scaling=true;this.scalingIndex=index;this.draw();
    const update=ev=>{if(Math.hypot(ev.clientX-e.clientX,ev.clientY-e.clientY)>3)moved=true;if(!moved)return;
      const q=px(this.point(ev,false));let k=Math.max(minScale,((q[0]-anchor[0])*diag[0]+(q[1]-anchor[1])*diag[1])/diagLen2);
      // 碰到画面边缘就停：在 [最小, 想要] 之间二分出不出画面的最大比例
      if(!inside(boxFor(k))){let lo=Math.min(minScale,1),hi=k;for(let i=0;i<24;i++){const m=(lo+hi)/2;if(inside(boxFor(m)))lo=m;else hi=m;}k=lo;}
      const box=boxFor(k).map(v=>Math.max(0,Math.min(1,v)));
      const fresh=structuredClone(before.find(row=>row.id===t.id));if(fresh.kind==='dynamic')ensureTrackChannels(fresh);setTrackPose(fresh,frame,{box,angle:pose.angle});
      this.node.document.tracks[this.node.document.tracks.findIndex(row=>row.id===t.id)]=fresh;this.selectedKey=frame;this.property='width';this.draw();};
    startEditorGesture(e,{element:this.canvas,scope:this.dialog,move:update,end:ev=>{update(ev);this.scaling=false;if(moved){this.commit(before);this.status('已等比缩放 · Ctrl+Z 撤销');}this.render();},cancel:()=>{this.scaling=false;this.node.document.tracks=before;this.render();}});
    return true;
  }
  track(){return this.node.document.tracks.find(t=>t.id===this.selected);}
  visibleTracks(){return this.node.document.tracks.filter(t=>this.category===t.kind);}
  status(text){if(!this.closed)this.$('[data-view="status"]').textContent=text;}
  hint(text){if(!this.closed)this.$('[data-view="hint"]').textContent=text;}
  applyCategory(){
    this.field('category').value=this.category;if(this.kindMirror&&!this.track())this.kindMirror.value=this.category;if(this.dynamicCoverLabel)this.dynamicCoverLabel.hidden=this.category==='static';
    this.$('[data-view="category"]').textContent=this.category==='static'?'静态遮罩':'动态遮罩';
    this.$('[data-view="mode"]').hidden=this.category==='static';
    this.$('[data-view="keyframes"]').hidden=false;
  }
  setCategory(category){
    cancelEditorGesture('category');this.video.pause();this.category=category;this.selected=null;this.selectedKey=null;
    if(category==='static')this.curvePanel?.setExpanded(false);
    this.applyCategory();this.setTool('select');this.render();this.rebuildUnion();
  }
  showPanel(name){
    for(const button of this.dialog.querySelectorAll('[data-tab]'))button.setAttribute('aria-selected',String(button.dataset.tab===name));
    for(const panel of this.dialog.querySelectorAll('[data-panel]'))panel.hidden=panel.dataset.panel!==name;
  }
  setTool(tool){
    this.keyFocus=false;
    cancelEditorGesture('tool');this.pathDrawing?.reset();this.video.pause();this.tool=tool;this.drawKind=tool==='draw'?this.category:null;this.pending=null;
    if(tool==='path')this.property='shape';
    this.hideContextMenu();this.renderTool();this.draw();this.curvePanel?.render();this.canvas.focus({preventScroll:true});
  }
  renderTool(){
    const tool=this.tool||'select';this.dialog.dataset.tool=tool;
    for(const [action,value] of [['select','select'],['add','draw'],['pen','pen'],['pan','pan']])this.$(`[data-action="${action}"]`).setAttribute('aria-pressed',String(tool===value));
    this.$('[data-view="tool"]').textContent={select:'选择工具',draw:`绘制${this.category==='static'?'静态':'动态'}遮罩`,pan:'平移画面',path:'编辑遮罩路径',pen:'钢笔绘制',merge:'合并遮罩'}[tool];
    this.$('[data-action=path-finish]').hidden=tool!=='pen';
    this.$('[data-action=path-handles]').setAttribute('aria-pressed',String(this.pathEditor?.addMode??false));
    this.canvas.style.cursor=this.video.seeking?'progress':{select:'default',draw:'crosshair',pan:'grab',path:'crosshair',pen:'crosshair',merge:'crosshair'}[tool];
    this.hint(this.video.error?'视频读取失败，请保存并重新打开。':this.video.readyState<2?'视频正在载入，工具已就绪，画面显示后即可操作。':this.video.seeking?'正在定位这一帧，工具会保持选中，画面就绪后即可操作。':{select:'单选即可拖锚点 / 拖边缘移动整条边 · W 添加锚点 · Alt 拖锚点拉曲线 · 中键轻点边缘加点 / 拖动平移 · 双击遮罩打开动画属性 · S 为已勾选属性设键',draw:'在视频画面上按住左键拖出矩形 · 可连续绘制 · Esc 返回选择',pan:'拖动画面平移 · 滚轮缩放 · F 恢复完整画面',path:'拖点和手柄 · Alt 拖锚点拉曲线 / 拖手柄断开 · 双击边缘加点 · W 添加锚点 · S 为已勾选属性设键 · Esc 完成',pen:'单击加点 · 按住拖动拉曲线 · 点首点或 Enter 闭合 · 可画到画幅外 · Esc 取消',merge:'按住左键拖框，框到的遮罩（至少两个）合成一块 · 静态合成轮廓、动态合成每帧外框 · Ctrl+Z 撤销 · M / Esc 退出'}[tool]);
  }
  toggleFocus(){this.curvePanel?.setExpanded(false);this.focusMode=!this.focusMode;this.dialog.classList.toggle('ui-mask-focus',this.focusMode);const b=this.$('[data-action="focus"]');b.setAttribute('aria-pressed',String(this.focusMode));b.textContent=this.focusMode?'恢复工作区 Tab':'专注画面 Tab';this.canvas.focus({preventScroll:true});}
  setupSplitters(){
    const bind=(selector,property,axis,initial,min,max)=>{const handle=this.$(selector);let size=initial;
      handle.setAttribute('aria-valuemin',min);handle.setAttribute('aria-valuemax',typeof max==='function'?300:max);handle.setAttribute('aria-valuenow',initial);handle.setAttribute('aria-valuetext',`${initial} 像素`);
      const set=value=>{size=Math.max(min,Math.min(typeof max==='function'?max():max,value));this.dialog.style.setProperty(property,`${size}px`);handle.setAttribute('aria-valuenow',Math.round(size));handle.setAttribute('aria-valuetext',`${Math.round(size)} 像素`);};
      handle.onpointerdown=e=>{if(e.button!==0)return;const start=axis==='y'?e.clientY:e.clientX,before=size;startEditorGesture(e,{element:handle,scope:this.dialog,move:ev=>set(before+start-(axis==='y'?ev.clientY:ev.clientX)),cancel:()=>set(before)});};
      handle.onkeydown=e=>{if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();set(size+(['ArrowUp','ArrowLeft'].includes(e.key)?20:-20));};
    };
    bind('.ui-mask-timeline-resizer','--timeline-height','y',310,260,()=>this.dialog.clientHeight*.7);
    bind('.ui-mask-inspector-resizer','--inspector-width','x',292,250,440);
  }
  pan(e){
    if(e.button!==0&&e.button!==1)return;const stage=this.$('.ui-mask-stage'),x=stage.scrollLeft,y=stage.scrollTop;
    let moved=false;
    this.canvas.style.cursor='grabbing';startEditorGesture(e,{element:this.canvas,scope:this.dialog,move:ev=>{
      if(!moved&&Math.hypot(ev.clientX-e.clientX,ev.clientY-e.clientY)<3)return;
      moved=true;stage.scrollLeft=x+e.clientX-ev.clientX;stage.scrollTop=y+e.clientY-ev.clientY;
    },end:ev=>{if(e.button===1&&!moved&&!this.node.busy&&!this.video.seeking&&this.video.readyState>=2)this.pathEditor?.insert(this.point(ev,false));this.renderTool();},cancel:()=>{stage.scrollLeft=x;stage.scrollTop=y;this.renderTool();}});
  }
  createCentered(){
    if(this.node.busy)return;this.video.pause();this.setTool('select');this.edit(()=>{const t=this.newTrack(this.category,[.35,.35,.65,.65],this.frame);this.node.document.tracks.push(t);this.selected=t.id;this.selectedKey=null;});
    this.status('已创建遮罩。拖动画面调整，或展开下方属性；点击码表开始动画。');
  }
  newTrack(kind,box,frame){const t=makeTrack(kind,box,frame,this.node.document.source.frames);if(kind==='dynamic')for(const c of Object.values(ensureTrackChannels(t)))c.keys=[];return this.modelLayer?this.modelLayer.decorate(t):t;}
  duplicate(){const tracks=this.selectedTracks();if(!tracks.length)return;this.edit(()=>{const copies=tracks.map(t=>{const copy=structuredClone(t);copy.id=randomUUID();delete copy.displayNumber;copy.label=`${t.label} 副本`;copy.origin='manual';return copy;});this.node.document.tracks.push(...copies);this.selectTracks(copies.map(t=>t.id));});}
  transformNumber(name){
    const t=this.track(),input=this.field(name);if(!t||input.value==='')return;
    if(!this.canTransform(t)){this.renderTransport();return;}
    const p=poseAt(t,this.frame),s=this.node.document.source;
    const box=numericMaskBox(p.box,name,Number(input.value),s.width,s.height);
    if(box.some((v,i)=>Math.abs(v-p.box[i])>.0000001)){this.property=name;this.edit(()=>{if(t.kind==='dynamic')ensureTrackChannels(t);setTrackPose(t,this.frame,{box,angle:p.angle});this.selectedKey=t.kind==='dynamic'?this.frame:null;});}
  }
  refreshJob(){
    if(this.closed)return;const busy=this.node.busy;
    this.$('[data-action="generate"]').disabled=busy||(!this.node.document.modelBase&&!this.visibleTracks().some(t=>t.enabled&&t.ranges.length));
    this.$('[data-action="generate"]').textContent=busy?'生成中…':'生成黑色遮罩视频';const sideGenerate=this.dialog.querySelector('.ui-mask-generate');if(sideGenerate)sideGenerate.disabled=this.$('[data-action="generate"]').disabled;
    this.$('[data-action="cancel-job"]').hidden=!busy;
    this.field('category').disabled=busy;if(this.dynamicCoverSelect)this.dynamicCoverSelect.disabled=true;
    for(const input of this.dialog.querySelectorAll('[data-view="selection"] input,[data-view="selection"] select,[name="ui-mask-mode"]'))input.disabled=busy;
    this.$('[data-action="undo"]').disabled=busy||!this.history.length;this.$('[data-action="redo"]').disabled=busy||!this.redo.length;
    for(const action of ['add','pen','path-handles','point-delete','path-finish','center','delete','duplicate','enable','disable','key-add','range-add','range-delete','start','end'])this.$(`[data-action="${action}"]`).disabled=busy||(['delete','duplicate','key-add','range-add','range-delete','start','end'].includes(action)&&!this.track());
    this.$('[data-action="key-delete"]').disabled=busy||this.selectedKey==null;
    this.field('key-frame').disabled=busy||this.selectedKey==null;
    this.modelLayer?.refresh();
    if(this.curvePanel&&this.wasBusy!==busy)this.curvePanel.render();
    if(this.jobView){this.jobView.hidden=!busy;const bar=this.jobView.querySelector('progress');bar.value=this.node.progress||0;const elapsed=this.node.jobStartedAt?Math.max(0,Math.round((Date.now()-this.node.jobStartedAt)/1000)):0;const clock=`${Math.floor(elapsed/60)}:${String(elapsed%60).padStart(2,'0')}`;this.jobView.querySelector('[data-view="job-text"]').textContent=busy?`${this.node.message||'正在生成'} · ${this.node.progress||0}% · 已用 ${clock}`:'';}
    if(busy||this.wasBusy)this.status(this.node.message);this.wasBusy=busy;
    const signature=JSON.stringify(this.node.results);if(signature!==this.resultSignature){this.resultSignature=signature;const list=this.$('[data-view="results"]');list.replaceChildren();for(const result of this.node.results){for(const [url,title,name] of [[result.downloadUrl,'下载 Mask 视频',result.filename],...(this.node.document.modelBase&&result.maskUrl?[[result.maskUrl,'下载黑白遮罩（辅助文件）','纯遮罩.mp4']]:[]),[result.referenceUrl,'下载配套首帧','配套首帧.png']]){const a=document.createElement('a');a.href=url;a.textContent=title;a.download=name;list.append(a);}}if(this.node.results.length){this.status('生成完成');}}
  }
  snapshot(){const tracks=structuredClone(this.node.document.tracks);(this.selectionHistory??=new WeakMap()).set(tracks,[...this.selectedIds]);return tracks;}
  commit(before){
    assignMaskNumbers(this.node.document);
    if(this.node.document.tracks.some(t=>t.animation))this.node.document.version=2;
    try{validateMaskDocument(this.node.document);}catch(e){this.node.document.tracks=before;this.selectTracks(this.selectionHistory?.get(before)||[]);this.status(e.message);this.render();return;}
    if(JSON.stringify(before)===JSON.stringify(this.node.document.tracks))return;
    for(const t of this.node.document.tracks)if(JSON.stringify(t)!==JSON.stringify(before.find(p=>p.id===t.id)))t.manualEdited=true;
    this.history.push(before);if(this.history.length>25)this.history.shift();this.redo=[];
    this.node.documentChanged();this.render();this.rebuildUnion();
  }
  edit(fn){if(this.node.busy)return;const before=this.snapshot();try{fn();this.commit(before);}catch(e){this.node.document.tracks=before;this.selectTracks(this.selectionHistory?.get(before)||[]);this.status(e.message);this.render();}}
  undo(){if(this.node.busy||!this.history.length)return;this.redo.push(this.snapshot());this.node.document.tracks=this.history.pop();this.selectTracks(this.selectionHistory?.get(this.node.document.tracks)||[]);this.node.documentChanged();this.render();this.rebuildUnion();}
  redoEdit(){if(this.node.busy||!this.redo.length)return;this.history.push(this.snapshot());this.node.document.tracks=this.redo.pop();this.selectTracks(this.selectionHistory?.get(this.node.document.tracks)||[]);this.node.documentChanged();this.render();this.rebuildUnion();}
  changeKind(kind,batch=false){const tracks=batch?this.selectedTracks():[this.track()].filter(Boolean);this.edit(()=>tracks.forEach(t=>changeTrackKind(t,kind,this.frame)));this.status(`已将 ${tracks.length} 个遮罩设为${kind==='static'?'静态':'动态'}；原轨迹和时段已保留，可切换类别继续编辑。`);}
  canTransform(t){if(this.node.busy)return false;if(this.video.seeking){this.hint('正在定位画面，请等这一帧显示后再调整。');return false;}if(!activeAt(t,this.frame)){this.hint('此遮罩在当前帧未出现。请在「时段与输出」跳到出现帧，或调整出现时段。');this.status('当前帧不在出现时段内，请先调整时段');return false;}return true;}
  addKey(){return this.curvePanel?.addChecked();}
  deleteKey(){if(this.curvePanel)return this.curvePanel.remove();const t=this.track();if(t?.kind!=='dynamic'||this.selectedKey==null)return;this.edit(()=>{ensureTrackChannels(t);deleteChannelKey(t,this.property,this.selectedKey);this.selectedKey=null;});}
  moveKey(frame){const t=this.track();if(!t||this.selectedKey==null)return;this.edit(()=>{ensureTrackChannels(t);moveChannelKey(t,this.property,this.selectedKey,frame,this.node.document.source.frames);this.selectedKey=frame;});if(this.selectedKey===frame)this.seek(frame);}
  jumpKey(direction){const t=this.track();if(!t)return;const keys=this.effectiveKeys(t);const key=direction<0?keys.filter(k=>k.frame<this.frame).at(-1):keys.find(k=>k.frame>this.frame);if(key){this.selectedKey=key.frame;this.keyFocus=true;this.seek(key.frame);this.renderKeys();}}
  effectiveKeys(t){if(t.animation)return t.animation.channels[this.property].keys;const copy=structuredClone(t);return ensureTrackChannels(copy)[this.property].keys;}
  renderKeys(){
    if(this.curvePanel){this.curvePanel.render();return;}
    this.curvePanel?.selectVisibleProperty();
    const t=this.track(),track=this.$('[data-view="keys"]'),frames=this.node.document.source.frames;track.replaceChildren();
    const keys=t?.kind==='dynamic'&&this.curvePanel?.hasMatch!==false?this.effectiveKeys(t):[];if(!keys.some(k=>k.frame===this.selectedKey))this.selectedKey=null;
    const width=Math.max(260,(this.$('.ui-mask-timeline-scroll').clientWidth-28)*this.timelineZoom)-80;track.style.width=`${width}px`;
    const ticks=Math.max(2,Math.floor(width/85)),step=Math.max(1,Math.ceil((frames-1)/ticks));
    for(let f=0;f<frames;f+=step){const tick=document.createElement('span');tick.className='ui-mask-tick';tick.style.left=`${f/Math.max(1,frames-1)*100}%`;tick.textContent=f+1;track.append(tick);}
    for(const [a,b] of t?.ranges||[]){const range=document.createElement('span');range.className='ui-mask-range';range.style.left=`${a/frames*100}%`;range.style.width=`${(b-a)/frames*100}%`;track.append(range);}
    track.onpointerdown=e=>{if(e.button!==0||e.target.closest('button'))return;const rect=track.getBoundingClientRect();const scrub=ev=>this.seek(Math.round((ev.clientX-rect.left)/rect.width*(frames-1)));scrub(e);startEditorGesture(e,{element:track,scope:this.dialog,move:scrub,end:scrub});};
    for(const key of keys){const button=document.createElement('button');button.type='button';button.className='ui-mask-key';button.dataset.frame=key.frame;button.textContent='◆';button.title=`第 ${key.frame+1} 帧：点击选中，拖动移键`;button.setAttribute('aria-label',`关键帧 ${key.frame+1}`);button.setAttribute('aria-pressed',String(key.frame===this.selectedKey));button.style.left=`${key.frame/Math.max(1,frames-1)*100}%`;
      button.onclick=()=>{this.selectedKey=key.frame;this.keyFocus=true;this.seek(key.frame);this.renderKeys();this.$(`[data-frame="${key.frame}"]`)?.focus();};
      button.onpointerdown=e=>{if(e.button!==0||this.node.busy)return;const rect=track.getBoundingClientRect(),from=key.frame;let to=from;this.video.pause();this.selectedKey=from;this.keyFocus=true;
        startEditorGesture(e,{element:button,scope:this.dialog,move:ev=>{to=Math.max(0,Math.min(frames-1,Math.round((ev.clientX-rect.left)/rect.width*(frames-1))));button.style.left=`${to/Math.max(1,frames-1)*100}%`;this.field('key-frame').value=to+1;},end:()=>{if(to!==from)this.moveKey(to);else{this.seek(from);this.renderKeys();}this.$(`[data-frame="${this.selectedKey}"]`)?.focus();},cancel:()=>this.renderKeys()});};track.appendChild(button);}
    const playhead=document.createElement('span');playhead.className='ui-mask-playhead';playhead.style.left=`${this.frame/Math.max(1,frames-1)*100}%`;track.appendChild(playhead);
    this.field('key-frame').max=frames;this.field('key-frame').disabled=this.selectedKey==null;this.field('key-frame').value=this.selectedKey==null?'':this.selectedKey+1;
    this.$('[data-action="key-delete"]').disabled=this.node.busy||this.selectedKey==null||this.curvePanel?.hasMatch===false;
    this.$('[data-view="key-caption"]').textContent=t?`${PROPERTY_NAMES[this.property]} · ${keys.length} 个关键帧 · 仅编辑当前属性 · 拖动曲线键／手柄；手柄距离单位：帧`:'先创建或选中一个动态遮罩，再添加关键帧';
    this.$('[data-action="key-add"]').textContent=`${PROPERTY_NAMES[this.property]} 设键 S`;
    this.curvePanel?.render();
  }
  add(){if(!this.node.busy)this.setTool('draw');}
  point(e,clip=true){return videoPoint(e,this.canvas.getBoundingClientRect(),clip);}
  hitTrack(p,includeTrail=false){
    const tracks=[...this.visibleTracks()].reverse(),contains=(t,f)=>{const points=trackPolygon(t,f,this.node.document.source);if(!points)return false;let inside=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;};
    const current=tracks.find(t=>contains(t,this.frame));if(current)return current;
    if(includeTrail&&this.node.getParam('dynamicMode')==='trail'){
      for(const t of tracks)if(t.enabled&&t.kind==='dynamic')for(const [a,b] of t.ranges)for(let f=a;f<b;f++)if(contains(t,f))return t;
    }
    return null;
  }
  openContextMenu(t,x,y){
    this.setTool('select');if(t&&!this.selectedIds.has(t.id))this.selected=t.id;this.render();
    this.contextTrackId=t?.id;const menu=this.contextMenu,tracks=this.selectedTracks();menu.hidden=false;
    menu.querySelector('[data-mask-choice="remove"]').disabled=this.node.busy||!tracks.some(t=>t.enabled);
    menu.querySelector('[data-mask-choice="remove"]').textContent=`停用选中${tracks.length?`（${tracks.length}）`:''}`;
    menu.querySelector('[data-mask-choice="confirm"]').disabled=this.node.busy||!tracks.some(t=>!t.enabled);
    menu.querySelector('[data-mask-choice="confirm"]').textContent='启用选中';
    for(const b of menu.querySelectorAll('[data-selection-action]'))b.disabled=['复制选中','删除选中'].includes(b.dataset.selectionAction)&&(this.node.busy||!tracks.length);
    for(const kind of ['static','dynamic']){const button=menu.querySelector(`[data-mask-choice="${kind}"]`),checked=!!tracks.length&&tracks.every(t=>t.kind===kind);button.disabled=this.node.busy||!tracks.length;button.setAttribute('aria-checked',String(checked));button.textContent=`${checked?'✓ ':''}选中设为${kind==='static'?'静态':'动态'}`;}
    const bounds=this.dialog.getBoundingClientRect(),rect=menu.getBoundingClientRect();
    menu.style.left=`${Math.max(bounds.left+6,Math.min(x,bounds.right-rect.width-6))}px`;
    menu.style.top=`${Math.max(bounds.top+6,Math.min(y,bounds.bottom-rect.height-6))}px`;
    menu.querySelector('button:not(:disabled)').focus({preventScroll:true});
  }
  hideContextMenu(restoreFocus=false){this.contextMenu.hidden=true;this.contextTrackId=null;if(restoreFocus)this.canvas.focus({preventScroll:true});}
  pointer(e){
    if(e.button===1||this.tool==='pan'){this.pan(e);return;}
    if(e.button!==0||this.node.busy)return;
    if(this.video.seeking||this.video.readyState<2){this.renderTool();return;}
    if(this.tool==='select'&&this.scaleGesture(e))return;
    if(this.pathEditor?.pointer(e))return;
    if(this.tool==='path')return;
    if(this.tool==='pen'){this.pathDrawing.pointer(e);return;}
    this.canvas.focus({preventScroll:true});this.video.pause();this.keyFocus=false;const p=this.point(e,!!this.drawKind),before=this.snapshot();let kind=this.drawKind,t,original,corner=-1,rotating=false,angle=0;
    if(!kind){
      if(e.ctrlKey||e.metaKey){this.marquee(e);return;}
      const r=this.canvas.getBoundingClientRect(),selected=this.track(),handles=this.selectedIds.size===1&&selected&&this.handles(selected),near=q=>Math.hypot((p[0]-q[0])*r.width,(p[1]-q[1])*r.height)<12;
      corner=handles&&!this.pathEditor?.active()?handles.corners.findIndex(near):-1;rotating=!!handles&&near(handles.rotation);
      t=corner>=0||rotating?selected:this.hitTrack(p);
      if(!t){this.marquee(e);return;}
      if(e.shiftKey||e.altKey){this.selectTracks(combineSelection([...this.selectedIds],[t.id],e.altKey?'subtract':'toggle'),t.id);this.render();return;}
      if(!this.selectedIds.has(t.id))this.selected=t.id;else this._selected=t.id;
      this.pathEditor?.clearSelection();this.selectedKey=null;original=boxAt(t,this.frame);angle=poseAt(t,this.frame).angle;this.render();
      if(!this.canTransform(t))return;
    }
    const frame=this.frame;let moved=false;
    const update=ev=>{const q=this.point(ev);if(Math.hypot(ev.clientX-e.clientX,ev.clientY-e.clientY)>3)moved=true;if(!kind&&!moved)return;if(kind){this.pending=[Math.min(p[0],q[0]),Math.min(p[1],q[1]),Math.max(p[0],q[0]),Math.max(p[1],q[1])];}
      else if(this.selectedIds.size>1&&corner<0&&!rotating){this.node.document.tracks=translateSelection(before,[...this.selectedIds],frame,[q[0]-p[0],q[1]-p[1]],this.node.document.source);this.property='x';}
      else{let b=[...original],nextAngle=angle;
        if(corner>=0)b=resizeMaskBox(original,angle,corner,[q[0]-p[0],q[1]-p[1]],this.canvas.width,this.canvas.height);
        else if(rotating){const cx=(b[0]+b[2])/2,cy=(b[1]+b[3])/2,a=v=>Math.atan2((v[1]-cy)*this.canvas.height,(v[0]-cx)*this.canvas.width);let delta=(a(q)-a(p))*180/Math.PI;delta=((delta+540)%360)-180;nextAngle=angle+delta;if(ev.shiftKey)nextAngle=Math.round(nextAngle/15)*15;}
        else{const dx=Math.max(-b[0],Math.min(1-b[2],q[0]-p[0])),dy=Math.max(-b[1],Math.min(1-b[3],q[1]-p[1]));b[0]+=dx;b[2]+=dx;b[1]+=dy;b[3]+=dy;}
        const fresh=structuredClone(before.find(row=>row.id===t.id));if(b.some((v,i)=>Math.abs(v-original[i])>1e-9)||Math.abs(nextAngle-angle)>1e-9){if(fresh.kind==='dynamic')ensureTrackChannels(fresh);setTrackPose(fresh,frame,{box:b,angle:nextAngle});this.selectedKey=frame;this.property=rotating?'angle':corner>=0?'width':'x';}this.node.document.tracks[this.node.document.tracks.findIndex(row=>row.id===t.id)]=fresh;}
      this.draw();};
    startEditorGesture(e,{element:this.canvas,scope:this.dialog,move:update,end:ev=>{
      update(ev);let created=false;if(kind&&this.pending&&(this.pending[2]-this.pending[0])*this.canvas.width>=3&&(this.pending[3]-this.pending[1])*this.canvas.height>=3){const track=this.newTrack(kind,this.pending,frame);this.node.document.tracks.push(track);this.selected=track.id;this.selectedKey=null;created=true;}
      if(!kind&&!moved){this.selected=t.id;this.render();}
      this.pending=null;this.commit(before);this.draw();this.renderTransport();
      if(kind)this.hint(created?'已创建遮罩，可继续画下一个；按 V 或 Esc 选择、移动和制作动画。':'范围太小，尚未创建。请按住左键拖出矩形，或按 C 居中添加。');
    },cancel:()=>{this.node.document.tracks=before;this.pending=null;this.selectedKey=null;this.render();this.hint('操作已取消，遮罩保持原样。');}});
  }
  handles(t){
    const b=boxAt(t,this.frame);if(!b)return null;
    const proxy={...t,polygon:undefined,appearance:undefined,staticAppearance:undefined},corners=trackPolygon(proxy,this.frame,this.node.document.source);
    const midpoint=[(corners[0][0]+corners[1][0])/2,(corners[0][1]+corners[1][1])/2],a=poseAt(t,this.frame).angle*Math.PI/180;
    const rect=this.canvas.getBoundingClientRect();
    // 等比缩放手柄：四个角各一个，从角往外沿对角线 22px（避开锚点和边的命中范围）
    const center=[(corners[0][0]+corners[2][0])/2,(corners[0][1]+corners[2][1])/2];
    const scales=corners.map(c=>{const dx=(c[0]-center[0])*rect.width,dy=(c[1]-center[1])*rect.height,len=Math.max(1,Math.hypot(dx,dy));return [c[0]+dx/len*22/rect.width,c[1]+dy/len*22/rect.height];});
    return {corners,midpoint,center,scales,rotation:[midpoint[0]+Math.sin(a)*24/rect.width,midpoint[1]-Math.cos(a)*24/rect.height]};
  }
  renderRange(){
    const t=this.track(),r=t?.ranges[Number(this.field('range').value)];
    this.field('first').value=r?r[0]+1:'';this.field('last').value=r?r[1]:'';
    this.field('first').disabled=this.field('last').disabled=!r;
    this.field('first').max=this.field('last').max=this.node.document.source.frames;
  }
  changeRange(which){this.edit(()=>{const t=this.track(),i=Number(this.field('range').value);if(!t?.ranges[i])return;t.ranges=trimOpacityRange(t.ranges,i,which==='start'?'start':'end',this.frame,this.node.document.source.frames);});}
  addRange(){this.edit(()=>{const t=this.track();if(!t)return;const rows=[...t.ranges,[this.frame,this.node.document.source.frames]].sort((a,b)=>a[0]-b[0]),merged=[];for(const r of rows){if(merged.length&&r[0]<=merged.at(-1)[1])merged.at(-1)[1]=Math.max(merged.at(-1)[1],r[1]);else merged.push([...r]);}t.ranges=merged;});}
  render(){
    const tracks=this.visibleTracks(),list=this.field('tracks'),search=this.maskSearch?.value.trim().toLowerCase()||'';
    const matches=tracks.filter(t=>`${maskDisplayId(t)} ${t.label}`.toLowerCase().includes(search));
    list.replaceChildren(...matches.map(t=>new Option(`${maskDisplayId(t)} · ${t.label}${t.enabled?'':' · 已停用'}`,t.id)));
    const validIds=new Set(tracks.map(t=>t.id));this.selectedIds=new Set([...this.selectedIds].filter(id=>validIds.has(id)));if(!this.selectedIds.has(this.selected))this._selected=[...this.selectedIds].at(-1)||null;
    const count=this.$('[data-selection-count]');if(count)count.textContent=this.selectedIds.size?`已选 ${this.selectedIds.size}`:'';
    const multi=this.selectedIds.size>1;this.dialog.classList.toggle('mask-multiselection',multi);
    if(this.selected&&!matches.some(t=>t.id===this.selected)&&tracks.some(t=>t.id===this.selected)){const current=this.track();list.add(new Option(`${maskDisplayId(current)} · ${current.label}（当前）`,current.id));}
    if(!this.selected){const placeholder=new Option('请选择遮罩','');list.add(placeholder,0);}
    list.value=this.selected||'';const t=this.track();this.$('[data-view="selection"]').hidden=!t;
    this.$('[data-view="empty"]').hidden=!!t;
    if(this.kindMirror){this.kindMirror.disabled=!t;this.kindMirror.value=t?t.kind:this.category;}if(this.dynamicCoverSelect)this.dynamicCoverSelect.disabled=true;
    if(t){this.field('enabled').checked=t.enabled;this.field('label').value=t.label;this.field('kind').value=t.kind;
      const prior=Number(this.field('range').value);this.field('range').replaceChildren(...t.ranges.map((r,i)=>new Option(`${r[0]+1}—${r[1]} 帧`,i)));this.field('range').value=Math.min(prior||0,t.ranges.length-1);this.renderRange();}
    const enabled=tracks.filter(t=>t.enabled&&t.ranges.length);
    this.$('[data-view="summary"]').textContent=`本次仅输出${this.category==='static'?'静态':'动态'}遮罩 · 已启用 ${enabled.length} 个`;
    this.$('[data-action="generate"]').disabled=!enabled.length||this.node.busy;const sideGenerate=this.dialog.querySelector('.ui-mask-generate');if(sideGenerate)sideGenerate.disabled=this.$('[data-action="generate"]').disabled;
    this.$('[data-action="undo"]').disabled=!this.history.length;this.$('[data-action="redo"]').disabled=!this.redo.length;
    this.draw();this.renderKeys();this.renderTransport();this.refreshJob();
  }
  // Playback's clock can lie between frames. Only a presented frame commits
  // both the source pixels and the mask index, including callbacks after pause.
  presentVideoFrame(mediaTime){
    if(this.closed||!Number.isFinite(mediaTime))return;
    this.pendingMediaTime=mediaTime;
    if(this.video.readyState<2)return;
    const frame=frameAt(this.node.document.source.times,mediaTime);
    // A queued presentation callback can precede completion of a manual seek.
    // Manual steps commit at seeked, when the requested pixels are available.
    if(this.seekTarget!=null||this.video.seeking)return;
    if(this.seekSettled&&this.video.paused&&frame!==this.frame)return;
    this.commitVideoFrame(frame);
  }
  commitVideoFrame(frame){
    if(this.closed)return;
    this.videoFrameContext.drawImage(this.video,0,0,this.videoFrame.width,this.videoFrame.height);
    this.hasVideoFrame=true;this.frame=frame;this.seekTarget=null;this.pendingMediaTime=null;
    this.draw();this.renderTransport();this.renderTool();
  }
  videoEvent(event){
    if(event==='play')this.seekSettled=false;
    if(this.video.requestVideoFrameCallback){
      if(event==='seeked'&&this.seekTarget!=null&&!this.video.seeking&&this.video.readyState>=2&&
          frameAt(this.node.document.source.times,this.video.currentTime)===this.seekTarget){
        this.seekSettled=true;this.commitVideoFrame(this.seekTarget);return;
      }
      // Chromium may report a presented frame while readyState is still 1.
      // Retry that timestamp when pixels are ready, never the playback clock.
      if(['loadeddata','seeked'].includes(event)&&this.pendingMediaTime!=null)this.presentVideoFrame(this.pendingMediaTime);
    }
    this.renderTransport();this.renderTool();
  }
  stepFrame(delta){this.seek((this.seekTarget??this.frame)+delta);}
  seek(frame){if(!Number.isFinite(frame))return;this.hideContextMenu();const s=this.node.document.source;this.video.pause();this.pendingMediaTime=null;this.seekTarget=Math.max(0,Math.min(s.frames-1,Math.round(frame)));if(this.seekPlayback)this.seekPlayback.seek(this.seekTarget);else{const next=s.times[this.seekTarget+1]??s.duration;this.video.currentTime=s.times[this.seekTarget]+Math.min(.01,(next-s.times[this.seekTarget])/2);}this.renderTransport();this.renderTool();}
  get playing(){return this.seekPlayback?this.seekPlayback.playing:!this.video.paused;}
  toggle(){this.hideContextMenu();if(!this.playing)this.video.play().catch(e=>this.status(e.message));else this.video.pause();}
  renderTransport(){
    const s=this.node.document.source;this.field('seek').value=this.frame;if(document.activeElement!==this.field('frame'))this.field('frame').value=this.frame+1;
    this.$('[data-view="time"]').textContent=`/ ${s.frames}`;this.$('[data-action="play"]').textContent=this.playing?'暂停':'播放';const t=this.track();
    if(t){const p=poseAt(t,this.frame),b=p.box;for(const [name,value] of Object.entries({angle:p.angle,x:b[0]*s.width,y:b[1]*s.height,width:(b[2]-b[0])*s.width,height:(b[3]-b[1])*s.height})){if(document.activeElement!==this.field(name))this.field(name).value=Math.round(value*100)/100;}
      this.$('[data-view="selection-hint"]').textContent=activeAt(t,this.frame)?(t.kind==='dynamic'?`第 ${this.frame+1} 帧 · 已开动画的属性单独 K；关闭动画的属性修改全段常量`:'静态变换对整个出现时段生效'):'当前帧未出现。到「时段与输出」跳到出现帧或调整时段。';}
    const cursor=this.$('.ui-mask-playhead');if(cursor)cursor.style.left=`${this.frame/Math.max(1,s.frames-1)*100}%`;
    this.curvePanel?.updateCursor();
  }
  fitWidth(){const r=this.$('.ui-mask-stage').getBoundingClientRect();return Math.max(1,Math.min(r.width-24,(r.height-24)*this.canvas.width/this.canvas.height));}
  setZoom(value,anchor,mode='relative'){
    if(this.dialog?.classList.contains('ui-mask-curve-focus'))return;
    const stage=this.$('.ui-mask-stage'),old=this.canvas.getBoundingClientRect(),bounds=stage.getBoundingClientRect();
    const a=anchor||[bounds.left+stage.clientWidth/2,bounds.top+stage.clientHeight/2],p=[(a[0]-old.left)/Math.max(1,old.width),(a[1]-old.top)/Math.max(1,old.height)];
    this.zoomMode=mode;this.zoom=mode==='actual'?this.canvas.width/this.fitWidth():Math.max(.25,Math.min(8,value));const width=mode==='actual'?this.canvas.width:this.fitWidth()*this.zoom;this.canvas.style.width=`${width}px`;this.canvas.style.height=`${width*this.canvas.height/this.canvas.width}px`;
    const next=this.canvas.getBoundingClientRect();stage.scrollLeft+=next.left+p[0]*next.width-a[0];stage.scrollTop+=next.top+p[1]*next.height-a[1];
    this.$('[data-view="zoom"]').textContent=`适应 · ${Math.round(width/this.canvas.width*100)}%`;this.draw();
  }
  fillTrack(ctx,t,frame,color){const b=boxAt(t,frame);if(!b)return;const w=this.canvas.width,h=this.canvas.height;ctx.fillStyle=color;
    if(t.polygon||poseAt(t,frame).angle%360||!isRectanglePath(pathAt(t,frame))){for(const [x,y,width] of polygonSpans(trackPolygon(t,frame,this.node.document.source),w,h))ctx.fillRect(x,y,width,1);}
    else ctx.fillRect(Math.floor(b[0]*w),Math.floor(b[1]*h),Math.ceil(b[2]*w)-Math.floor(b[0]*w),Math.ceil(b[3]*h)-Math.floor(b[1]*h));}
  async rebuildUnion(){
    const version=this.unionVersion=(this.unionVersion||0)+1;this.union=null;
    if(this.category!=='dynamic'||this.node.getParam('dynamicMode')!=='trail'){this.draw();return;}
    this.status('计算拖尾覆盖预览…');const layer=document.createElement('canvas');layer.width=this.canvas.width;layer.height=this.canvas.height;const ctx=layer.getContext('2d'),w=layer.width,h=layer.height,pixels=ctx.createImageData(w,h);
    const tracks=structuredClone(this.visibleTracks().filter(t=>t.enabled&&t.kind==='dynamic'));let count=0;
    for(const t of tracks)for(const [a,b] of t.ranges)for(let f=a;f<b;f++){
      if(this.closed||version!==this.unionVersion)return;
      const b=boxAt(t,f),alpha=Math.round(opacityAt(t,f)*255);if(!b||!alpha)continue;
      const span=(x,y,length)=>{if(y<0||y>=h)return;for(let col=Math.max(0,x),end=Math.min(w,x+length);col<end;col++){const i=(y*w+col)*4+3;pixels.data[i]=Math.max(pixels.data[i],alpha);}};
      if(t.polygon||poseAt(t,f).angle%360||!isRectanglePath(pathAt(t,f)))for(const row of polygonSpans(trackPolygon(t,f,this.node.document.source),w,h))span(...row);
      else for(let y=Math.floor(b[1]*h);y<Math.ceil(b[3]*h);y++)span(Math.floor(b[0]*w),y,Math.ceil(b[2]*w)-Math.floor(b[0]*w));
      if(++count%100===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(this.closed||version!==this.unionVersion)return;ctx.putImageData(pixels,0,0);this.union=layer;this.status('拖尾模式从视频开始覆盖完整轨迹；重叠处保留最高不透明度。');this.draw();
  }
  draw(){
    const ctx=this.ctx,w=this.canvas.width,h=this.canvas.height;ctx.clearRect(0,0,w,h);
    if(this.hasVideoFrame)ctx.drawImage(this.videoFrame,0,0,w,h);
    const overlay=this.field('overlay').checked,trail=this.category==='dynamic'&&this.node.getParam('dynamicMode')==='trail';
    const opacity=Number(this.field('opacity').value)/100;
    if(overlay&&this.modelLayer)this.modelLayer.draw(ctx,opacity);
    if(overlay&&trail&&this.union){ctx.globalAlpha=opacity;ctx.drawImage(this.union,0,0);ctx.globalAlpha=1;}
    const scale=w/Math.max(1,this.canvas.getBoundingClientRect().width);
    for(const t of this.visibleTracks()){
      const b=boxAt(t,this.frame);if(!b)continue;
      if(overlay&&!this.modelLayer&&t.enabled&&(!trail||t.kind==='static')){ctx.globalAlpha=opacity*Math.round(opacityAt(t,this.frame)*255)/255;this.fillTrack(ctx,t,this.frame,'#000');ctx.globalAlpha=1;}
      ctx.strokeStyle=this.selectedIds.has(t.id)?'#aaf7e1':t.enabled?(t.kind==='static'?'#57d9b4':'#ab99ff'):'#777';ctx.lineWidth=(this.selectedIds.has(t.id)?3:1)*scale;
      if(t.maskOperation==='erase'&&t.enabled)ctx.strokeStyle='#ffb469';
      const points=trackPolygon(t,this.frame,this.node.document.source);ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p[0]*w,p[1]*h):ctx.moveTo(p[0]*w,p[1]*h));ctx.closePath();ctx.stroke();
      if(this.selectedIds.has(t.id)){ctx.font=`${22*scale}px system-ui`;const label=maskDisplayId(t),lx=Math.max(0,b[0]*w),ly=Math.max(28*scale,b[1]*h-6*scale);ctx.fillStyle='#172c3e';ctx.fillRect(lx,ly-24*scale,ctx.measureText(label).width+10*scale,30*scale);ctx.fillStyle='#bbf7e5';ctx.fillText(label,lx+5*scale,ly);}
      if(this.selectedIds.size===1&&t.id===this.selected&&!['draw','path','pen','merge'].includes(this.tool)){const handles=this.handles(t);ctx.fillStyle='#f0fff9';ctx.strokeStyle='#8ce1cd';ctx.lineWidth=scale;if(!this.pathEditor?.active())for(const corner of handles.corners)ctx.fillRect(corner[0]*w-4*scale,corner[1]*h-4*scale,8*scale,8*scale);ctx.beginPath();ctx.moveTo(handles.midpoint[0]*w,handles.midpoint[1]*h);ctx.lineTo(handles.rotation[0]*w,handles.rotation[1]*h);ctx.stroke();ctx.beginPath();ctx.arc(handles.rotation[0]*w,handles.rotation[1]*h,5*scale,0,Math.PI*2);ctx.fill();if(this.tool==='select')for(const [si,sp] of handles.scales.entries()){const hot=si===(this.scaling?this.scalingIndex:this.scaleHot),sx=sp[0]*w,sy=sp[1]*h,r=(hot?9:7)*scale,flip=si%2?-1:1;ctx.fillStyle=hot?'#ffe095':'#172c3e';ctx.strokeStyle=hot?'#fff3c4':'#8ce1cd';ctx.lineWidth=1.5*scale;ctx.fillRect(sx-r,sy-r,r*2,r*2);ctx.strokeRect(sx-r,sy-r,r*2,r*2);ctx.strokeStyle=hot?'#172c3e':'#bbf7e5';ctx.beginPath();ctx.moveTo(sx-r*.55*flip,sy-r*.55);ctx.lineTo(sx+r*.55*flip,sy+r*.55);ctx.moveTo(sx+r*.55*flip,sy+r*.05);ctx.lineTo(sx+r*.55*flip,sy+r*.55);ctx.lineTo(sx+r*.05*flip,sy+r*.55);ctx.moveTo(sx-r*.55*flip,sy-r*.05);ctx.lineTo(sx-r*.55*flip,sy-r*.55);ctx.lineTo(sx-r*.05*flip,sy-r*.55);ctx.stroke();}}
    }
    if(this.pending){const b=this.pending;ctx.fillStyle='#69d5b938';ctx.fillRect(b[0]*w,b[1]*h,(b[2]-b[0])*w,(b[3]-b[1])*h);ctx.strokeStyle='#97ffe4';ctx.lineWidth=2*scale;ctx.strokeRect(b[0]*w,b[1]*h,(b[2]-b[0])*w,(b[3]-b[1])*h);}
    if(this.marqueeBox){const b=this.marqueeBox;ctx.fillStyle='#75dcca20';ctx.fillRect(b[0]*w,b[1]*h,(b[2]-b[0])*w,(b[3]-b[1])*h);ctx.strokeStyle='#aaf7e1';ctx.lineWidth=scale;ctx.setLineDash([5*scale,3*scale]);ctx.strokeRect(b[0]*w,b[1]*h,(b[2]-b[0])*w,(b[3]-b[1])*h);ctx.setLineDash([]);}
    this.viewport?.draw();
  }
  async saveAndClose(){
    if(this.closing||this.closed)return;this.closing=true;
    try{await this.node.flushDocument();this.close();}
    catch(error){this.status(`保存未完成：${error.message}。草稿仍在此窗口，请重试保存。`);}
    finally{this.closing=false;}
  }
  close(){if(this.closed)return;this.closed=true;this.unionVersion++;this.abort.abort();this.resizeObserver?.disconnect();this.curvePanel?.close();this.seekPlayback?.close();this.video.pause();if(this.callback)this.video.cancelVideoFrameCallback(this.callback);this.video.removeAttribute('src');this.video.load();this.release?.();this.dialog.close();this.dialog.remove();this.node.editor=null;this.node.flushDocument().catch(e=>this.node.show(e.message));}
}


