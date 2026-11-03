from pathlib import Path
html = Path("/data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html").read_text(encoding="utf-8", errors="replace")
for line in html.splitlines():
    if "index-empty-video-copy" in line:
        print(line.strip())
js = Path("/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js").read_text(encoding="utf-8", errors="replace")
old = "Pe=it&&_&&(be||Fe)?c.jsx(Op,{actions:yt}):void 0"
print("count", js.count(old))
