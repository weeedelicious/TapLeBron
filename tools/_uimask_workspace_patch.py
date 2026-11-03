from pathlib import Path

bundle = Path("/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js")
html = Path("/data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html")
text = bundle.read_text(encoding="utf-8")
start = text.find("function ZmaskNode(")
end = text.find("const D5t=", start)
if start < 0 or end < 0:
    raise SystemExit(f"node anchors missing {start} {end}")
replacement = r'''function ZmaskNode({id:t,data:e,selected:n}){const r=((e.params||{}).videoList||[])[0]||null,i=r&&r.url||"",open=!!(n&&i),detail={url:i,nodeId:t,projectUuid:e.projectUuid,name:e.name,sourceNodeId:r&&r.nodeId};y.useEffect(()=>{if(open&&window.ShotflowUiMask&&window.ShotflowUiMask.openWorkspace)window.ShotflowUiMask.openWorkspace(detail)},[open,t,i,e.projectUuid,e.name,r&&r.nodeId]);return c.jsxs("div",{style:{width:280,position:"relative"},children:[c.jsx(Cl,{type:"target",position:"left",id:"video"}),c.jsx(Cl,{type:"source",position:"right",id:"out"}),c.jsxs("div",{style:{background:"#172331",color:"#dce5ee",border:n?"1px solid #49b6a5":"1px solid #344b62",borderRadius:14,boxShadow:"0 16px 40px rgba(0,0,0,.35)",overflow:"hidden"},children:[c.jsx("div",{style:{padding:"12px 14px",fontWeight:650,cursor:"grab"},children:e.name||"UI遮罩"}),c.jsx("div",{style:{padding:"0 14px 12px",color:i?"#9eb1c4":"#e8b478",fontSize:12},children:i?"点节点打开遮罩创作工作台":"先把视频连到这个节点"})]}),open&&c.jsxs("div",{className:"nodrag nopan nowheel",style:{position:"absolute",top:"calc(100% + 12px)",left:0,width:320,zIndex:40,background:"#172331",color:"#dce5ee",border:"1px solid #49b6a5",borderRadius:14,boxShadow:"0 18px 50px rgba(0,0,0,.45)",padding:12},children:[c.jsx("strong",{style:{fontSize:14},children:"遮罩创作工作台"}),c.jsx("p",{style:{margin:"8px 0",color:"#9eb1c4",fontSize:12},children:"主界面是全屏工作台：画面、钢笔、矩形、时间轴和辅助识别都在那里。"}),c.jsxs("div",{style:{display:"flex",gap:8},children:[c.jsx("button",{type:"button",onClick:ev=>{ev.stopPropagation();window.ShotflowUiMask&&window.ShotflowUiMask.openWorkspace&&window.ShotflowUiMask.openWorkspace(detail)},style:{background:"#24766e",border:"1px solid #49b6a5",borderRadius:6,color:"#e7f1fb",padding:"6px 10px",cursor:"pointer"},children:"打开主界面"}),c.jsx("button",{type:"button",onClick:ev=>{ev.stopPropagation();st.getState().setSelected([])},style:{background:"#243446",border:"1px solid #486176",borderRadius:6,color:"#e7f1fb",padding:"6px 10px",cursor:"pointer"},children:"关闭"})]})]})]})}'''
text = text[:start] + replacement + text[end:]
bundle.write_text(text, encoding="utf-8")
page = html.read_text(encoding="utf-8")
page2 = page.replace("20261028-ui-mask-popup", "20261028-ui-mask-workspace")
if page2 == page:
    raise SystemExit("html cache anchor missing")
html.write_text(page2, encoding="utf-8")
print("workspace node patched")
