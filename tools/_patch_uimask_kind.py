from pathlib import Path
p = Path('/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js')
t = p.read_text(encoding='utf-8')
old = "onClick:async()=>{if(!Q||!window.ShotflowUiMask)return;const St=st.getState(),Nt=St.nodes.find(Gr=>Gr.id===t||Gr.data.nodeKey===t),sn=Nt?.position??{x:0,y:0},An=St.edges.filter(Gr=>Gr.source===t||Gr.source===Nt?.id).length,On={nodeId:t,url:Q,mediaType:\"video\"},Qn=r(\"video\",sn.x+(Number(ps)||620)+140,sn.y+An*44,{name:(e.name||\"视频\")+\" · UI遮罩\",url:[Q],action:\"video_generate\",sourceKind:\"ui_mask\",params:{...$o(),modeType:\"video-edit\",videoList:[On],mixedList:[On],mixedListOrder:[t]}});try{await f()}catch{}const live=st.getState();live.setSelected([Qn.id]);live.setActivePanelNode(Qn.id);window.ShotflowUiMask.open({url:Q,nodeId:Qn.id,sourceNodeId:t,projectUuid:e.projectUuid,name:(Qn.data&&Qn.data.name)||((e.name||\"视频\")+\" · UI遮罩\")})}"
new = "onClick:()=>{if(!Q)return;const St=st.getState(),Nt=St.nodes.find(Gr=>Gr.id===t||Gr.data.nodeKey===t),sn=Nt?.position??{x:0,y:0},An=St.edges.filter(Gr=>Gr.source===t||Gr.source===Nt?.id).length,On={nodeId:t,url:Q,mediaType:\"video\"},Qn=r(\"ui_mask\",sn.x+(Number(ps)||620)+80,sn.y+An*44,{type:\"ui_mask\",name:\"UI遮罩\",url:[],action:\"ui_mask\",sourceKind:\"ui_mask\",contentWidth:560,contentHeight:520,params:{videoList:[On]}});const live=st.getState();live.setSelected([Qn.id]);live.setActivePanelNode(null)}"
print('click', t.count(old))
assert t.count(old)==1
t = t.replace(old, new, 1)
anchor = 'const D5t={image:v1t,video:s2t'
print('types', t.count(anchor))
assert t.count(anchor)==1
assert 'ui_mask:ZmaskNode' not in t
t = t.replace(anchor, "function ZmaskNode({id:t,data:e}){const n=y.useRef(null),r=((e.params||{}).videoList||[])[0]||null,i=r&&r.url||\"\";y.useEffect(()=>{const o=n.current;if(!o||!i||!window.ShotflowUiMask||!window.ShotflowUiMask.mount)return;return window.ShotflowUiMask.mount(o,{url:i,nodeId:t,projectUuid:e.projectUuid,name:e.name,sourceNodeId:r&&r.nodeId})},[t,i,e.projectUuid,e.name,r&&r.nodeId]);return c.jsxs(\"div\",{style:{width:560,background:\"#172331\",color:\"#dce5ee\",border:\"1px solid #344b62\",borderRadius:14,boxShadow:\"0 16px 40px rgba(0,0,0,.35)\",overflow:\"hidden\"},children:[c.jsx(Cl,{type:\"target\",position:\"left\",id:\"video\"}),c.jsx(\"div\",{style:{padding:\"10px 12px\",fontWeight:650,cursor:\"grab\"},children:e.name||\"UI遮罩\"}),c.jsx(\"div\",{ref:n,className:\"nodrag nopan\",style:{padding:\"0 12px 12px\",maxHeight:680,overflow:\"auto\"}})]})};" + anchor, 1)
t = t.replace('video_compare:N5t}', 'video_compare:N5t,ui_mask:ZmaskNode}', 1)
print('reg', t.count('ui_mask:ZmaskNode'))
assert t.count('ui_mask:ZmaskNode')==1
oldloe = 'word:15}'
print('loe', t.count(oldloe))
assert t.count(oldloe)==1
t = t.replace(oldloe, 'word:15,ui_mask:16}', 1)
p.write_text(t, encoding='utf-8')
html = Path('/data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html')
h = html.read_text(encoding='utf-8')
oldv = 'index-empty-video-copy.js?v=20261023-ui-mask-expand'
newv = 'index-empty-video-copy.js?v=20261023-ui-mask-kind'
print('html', h.count(oldv))
assert h.count(oldv)==1
html.write_text(h.replace(oldv, newv, 1), encoding='utf-8')
print('ok')