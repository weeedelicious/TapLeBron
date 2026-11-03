from pathlib import Path

bundle = Path("/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js")
html = Path("/data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html")
text = bundle.read_text(encoding="utf-8")
start = text.find("function ZmaskNode(")
end = text.find("const D5t=", start)
if start < 0 or end < 0:
    raise SystemExit(f"node anchors missing {start} {end}")
replacement = r'''function ZmaskNode({id:t,data:e,selected:n}){const a=y.useRef(null),placed=y.useRef(""),r=((e.params||{}).videoList||[])[0]||null,i=r&&r.url||"";y.useEffect(()=>{const o=a.current;if(!o||!i||!window.ShotflowUiMask||!window.ShotflowUiMask.mount)return;return window.ShotflowUiMask.mount(o,{url:i,nodeId:t,projectUuid:e.projectUuid,name:e.name,sourceNodeId:r&&r.nodeId,onOutput:item=>{if(!item||!item.url||placed.current===item.url)return;placed.current=item.url;const live=st.getState(),self=live.nodes.find(Gr=>Gr.id===t),pos=self?.position??{x:0,y:0},count=live.edges.filter(Gr=>Gr.source===t).length;live.addNodeAt("video",pos.x+720,pos.y+count*48,{name:(e.name||"UI遮罩")+" · 盖黑",url:[item.url],sourceKind:"ui_mask"})}})},[t,i,e.projectUuid,e.name,r&&r.nodeId]);return c.jsxs("div",{style:{width:640,position:"relative"},children:[c.jsx(Cl,{type:"target",position:"left",id:"video"}),c.jsx(Cl,{type:"source",position:"right",id:"out"}),c.jsxs("div",{style:{background:"#172331",color:"#dce5ee",border:n?"1px solid #49b6a5":"1px solid #344b62",borderRadius:14,boxShadow:"0 16px 40px rgba(0,0,0,.35)",overflow:"hidden"},children:[c.jsx("div",{style:{padding:"12px 14px",fontWeight:650,cursor:"grab"},children:e.name||"UI遮罩"}),c.jsx("div",{style:{padding:"0 14px 8px",color:i?"#9eb1c4":"#e8b478",fontSize:12},children:i?"静态 / 动态遮罩、AI 辅助、基础识别、手画、盖黑导出":"先把视频连到这个节点"}),c.jsx("div",{ref:a,className:"nodrag nopan",style:{display:i?"block":"none",padding:"0 8px 12px",maxHeight:640,overflow:"auto"}})]})]})}'''
text = text[:start] + replacement + text[end:]
old_size = 'contentWidth:280,contentHeight:92,params:{videoList:[On]}'
new_size = 'contentWidth:640,contentHeight:520,params:{videoList:[On]}'
if old_size not in text:
    raise SystemExit("create-node size anchor missing")
text = text.replace(old_size, new_size, 1)
bundle.write_text(text, encoding="utf-8")
page = html.read_text(encoding="utf-8")
page2 = page.replace("/ui-mask-bridge.js?v=20261023-ui-mask-kind", "/ui-mask-bridge.js?v=20261028-ui-mask-rewrite")
page2 = page2.replace("/assets/index-empty-video-copy.js?v=20261028-empty-right", "/assets/index-empty-video-copy.js?v=20261028-ui-mask-rewrite")
if page2 == page:
    raise SystemExit("html cache anchors missing")
html.write_text(page2, encoding="utf-8")
print("patched", start, "bytes", bundle.stat().st_size)
