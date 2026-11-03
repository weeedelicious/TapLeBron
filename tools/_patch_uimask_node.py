from pathlib import Path
p = Path('/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js')
t = p.read_text(encoding='utf-8')
old = "onClick:()=>{Q&&window.ShotflowUiMask&&window.ShotflowUiMask.open({url:Q,nodeId:t,projectUuid:e.projectUuid,name:e.name})}"
new = "onClick:async()=>{if(!Q||!window.ShotflowUiMask)return;const St=st.getState(),Nt=St.nodes.find(Gr=>Gr.id===t||Gr.data.nodeKey===t),sn=Nt?.position??{x:0,y:0},An=St.edges.filter(Gr=>Gr.source===t||Gr.source===Nt?.id).length,On={nodeId:t,url:Q,mediaType:\"video\"},Qn=r(\"video\",sn.x+(Number(ps)||620)+140,sn.y+An*44,{name:(e.name||\"视频\")+\" · UI遮罩\",url:[],action:\"image_resource\",sourceKind:\"ui_mask\",params:{...$o(),modeType:\"video-edit\",videoList:[On],mixedList:[On],mixedListOrder:[t]}});try{await f()}catch{}window.ShotflowUiMask.open({url:Q,nodeId:Qn.id,sourceNodeId:t,projectUuid:e.projectUuid,name:(Qn.data&&Qn.data.name)||((e.name||\"视频\")+\" · UI遮罩\")})}"
print('click', t.count(old))
assert t.count(old)==1
t = t.replace(old, new, 1)
p.write_text(t, encoding='utf-8')
html = Path('/data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html')
h = html.read_text(encoding='utf-8')
oldv = 'index-empty-video-copy.js?v=20261022-sync-duration'
newv = 'index-empty-video-copy.js?v=20261023-ui-mask-node'
print('html', h.count(oldv))
assert h.count(oldv)==1
html.write_text(h.replace(oldv, newv, 1), encoding='utf-8')
print('ok')