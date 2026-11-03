from pathlib import Path
p = Path('/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js')
t = p.read_text(encoding='utf-8')
old = "name:(e.name||\"视频\")+\" · UI遮罩\",url:[],action:\"image_resource\",sourceKind:\"ui_mask\""
new = "name:(e.name||\"视频\")+\" · UI遮罩\",url:[Q],action:\"video_generate\",sourceKind:\"ui_mask\""
old2 = "try{await f()}catch{}window.ShotflowUiMask.open"
new2 = "try{await f()}catch{}const live=st.getState();live.setSelected([Qn.id]);live.setActivePanelNode(Qn.id);window.ShotflowUiMask.open"
print('a', t.count(old), 'b', t.count(old2))
assert t.count(old)==1 and t.count(old2)==1
t = t.replace(old, new, 1).replace(old2, new2, 1)
p.write_text(t, encoding='utf-8')
html = Path('/data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html')
h = html.read_text(encoding='utf-8')
oldv = 'index-empty-video-copy.js?v=20261023-ui-mask-node'
newv = 'index-empty-video-copy.js?v=20261023-ui-mask-expand'
print('html', h.count(oldv))
assert h.count(oldv)==1
html.write_text(h.replace(oldv, newv, 1), encoding='utf-8')
print('ok')