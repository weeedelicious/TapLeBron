from pathlib import Path

bundle = Path("/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js")
html = Path("/data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html")
text = bundle.read_text(encoding="utf-8")
start = text.find("function ZmaskNode(")
end = text.find("const D5t=", start)
if start < 0 or end < 0:
    raise SystemExit(f"node anchors missing {start} {end}")
replacement = r'''function ZmaskNode({id:t,data:e,selected:n}){const a=y.useRef(null),placed=y.useRef(""),r=((e.params||{}).videoList||[])[0]||null,i=r&&r.url||"",open=!!(n&&i);y.useEffect(()=>{const o=a.current;if(!open||!o||!window.ShotflowUiMask||!window.ShotflowUiMask.mount)return;return window.ShotflowUiMask.mount(o,{url:i,nodeId:t,projectUuid:e.projectUuid,name:e.name,sourceNodeId:r&&r.nodeId,onOutput:item=>{if(!item||!item.url||placed.current===item.url)return;placed.current=item.url;const live=st.getState(),self=live.nodes.find(Gr=>Gr.id===t),pos=self?.position??{x:0,y:0},count=live.edges.filter(Gr=>Gr.source===t).length;live.addNodeAt("video",pos.x+420,pos.y+count*48,{name:(e.name||"UI遮罩")+" · 盖黑",url:[item.url],sourceKind:"ui_mask"})}})},[open,t,i,e.projectUuid,e.name,r&&r.nodeId]);return c.jsxs("div",{style:{width:280,position:"relative"},children:[c.jsx(Cl,{type:"target",position:"left",id:"video"}),c.jsx(Cl,{type:"source",position:"right",id:"out"}),c.jsxs("div",{style:{background:"#172331",color:"#dce5ee",border:n?"1px solid #49b6a5":"1px solid #344b62",borderRadius:14,boxShadow:"0 16px 40px rgba(0,0,0,.35)",overflow:"hidden"},children:[c.jsx("div",{style:{padding:"12px 14px",fontWeight:650,cursor:"grab"},children:e.name||"UI遮罩"}),c.jsx("div",{style:{padding:"0 14px 12px",color:i?"#9eb1c4":"#e8b478",fontSize:12},children:i?"点节点打开遮罩弹窗":"先把视频连到这个节点"})]}),open&&c.jsxs("div",{className:"nodrag nopan nowheel",style:{position:"absolute",top:"calc(100% + 12px)",left:0,width:640,zIndex:40,background:"#172331",color:"#dce5ee",border:"1px solid #49b6a5",borderRadius:14,boxShadow:"0 18px 50px rgba(0,0,0,.45)",maxHeight:"min(720px, 70vh)",overflow:"auto"},children:[c.jsxs("div",{style:{display:"flex",alignItems:"center",gap:8,padding:"10px 12px 0"},children:[c.jsx("strong",{style:{fontSize:14},children:"UI 遮罩"}),c.jsx("span",{style:{color:"#9eb1c4",fontSize:12,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},children:e.name||"当前视频"}),c.jsx("button",{type:"button",onClick:ev=>{ev.stopPropagation();st.getState().setSelected([])},style:{marginLeft:"auto",background:"#243446",border:"1px solid #486176",borderRadius:6,color:"#e7f1fb",padding:"4px 10px",cursor:"pointer"},children:"关闭"})]}),c.jsx("div",{ref:a,style:{padding:"0 8px 12px"}})]})]})}'''
text = text[:start] + replacement + text[end:]
text = text.replace(
    "contentWidth:640,contentHeight:520,params:{videoList:[On]}",
    "contentWidth:280,contentHeight:92,params:{videoList:[On]}",
    1,
)
bundle.write_text(text, encoding="utf-8")
page = html.read_text(encoding="utf-8")
page2 = page.replace("20261028-ui-mask-rewrite", "20261028-ui-mask-popup")
if page2 == page:
    raise SystemExit("html cache anchor missing")
html.write_text(page2, encoding="utf-8")
print("popup patched", end - start)
