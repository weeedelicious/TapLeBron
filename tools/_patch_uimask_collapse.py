from pathlib import Path
p = Path('/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js')
t = p.read_text(encoding='utf-8')
start = t.find("function ZmaskNode({id:t,data:e}){")
print('start', start)
assert start > 0
end = t.find(';const D5t=', start)
print('end', end)
assert end > start
t = t[:start] + "function ZmaskNode({id:t,data:e,selected:n}){const a=y.useRef(null),r=((e.params||{}).videoList||[])[0]||null,i=r&&r.url||\"\";y.useEffect(()=>{if(!n)return;const o=a.current;if(!o||!i||!window.ShotflowUiMask||!window.ShotflowUiMask.mount)return;return window.ShotflowUiMask.mount(o,{url:i,nodeId:t,projectUuid:e.projectUuid,name:e.name,sourceNodeId:r&&r.nodeId})},[n,t,i,e.projectUuid,e.name,r&&r.nodeId]);return c.jsxs(\"div\",{style:{width:280,position:\"relative\"},children:[c.jsx(Cl,{type:\"target\",position:\"left\",id:\"video\"}),c.jsxs(\"div\",{style:{background:\"#172331\",color:\"#dce5ee\",border:\"1px solid #344b62\",borderRadius:14,boxShadow:\"0 16px 40px rgba(0,0,0,.35)\",overflow:\"hidden\"},children:[c.jsx(\"div\",{style:{padding:\"12px 14px\",fontWeight:650,cursor:\"grab\"},children:e.name||\"UI遮罩\"}),c.jsx(\"div\",{style:{padding:\"0 14px 12px\",color:i?\"#9eb1c4\":\"#e8b478\",fontSize:12},children:i?\"已连接视频，点节点展开工具\":\"先把视频连到这个节点\"})]}),n&&c.jsx(\"div\",{ref:a,className:\"nodrag nopan\",style:{position:\"absolute\",top:\"calc(100% + 12px)\",left:0,width:560,zIndex:30,background:\"#172331\",color:\"#dce5ee\",border:\"1px solid #344b62\",borderRadius:14,boxShadow:\"0 18px 50px rgba(0,0,0,.45)\",padding:12,maxHeight:720,overflow:\"auto\"}})]})}" + t[end:]
oldSize = 'contentWidth:560,contentHeight:520'
newSize = 'contentWidth:280,contentHeight:92'
print('size', t.count(oldSize))
assert t.count(oldSize)==1
t = t.replace(oldSize, newSize, 1)
p.write_text(t, encoding='utf-8')
html = Path('/data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html')
h = html.read_text(encoding='utf-8')
oldv = 'index-empty-video-copy.js?v=20261023-ui-mask-kind'
newv = 'index-empty-video-copy.js?v=20261023-ui-mask-collapse'
print('html', h.count(oldv))
assert h.count(oldv)==1
html.write_text(h.replace(oldv, newv, 1), encoding='utf-8')
print('ok')