from pathlib import Path
import os, subprocess
js_path = Path("/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js")
html_path = Path("/data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html")
bak = Path("/data/wyx_root/tapflow-workbench/backups/upload-toolbar-20261027")
bak.mkdir(parents=True, exist_ok=True)
js = js_path.read_text(encoding="utf-8")
old = "Pe=it&&_&&(be||Fe)?c.jsx(Op,{actions:yt}):void 0"
new = "Pe=it&&(be||Fe)?c.jsx(Op,{actions:yt}):void 0"
if js.count(old) != 1:
    raise SystemExit("js %s" % js.count(old))
js = js.replace(old, new, 1)
stat = js_path.stat()
js_path.write_text(js, encoding="utf-8")
Path("/tmp/sf-upload-toolbar.mjs").write_text(js, encoding="utf-8")
result = subprocess.run(["node", "--check", "/tmp/sf-upload-toolbar.mjs"], capture_output=True, text=True)
print("check", result.returncode)
if result.returncode != 0:
    print(result.stderr[-400:])
    raise SystemExit("bad")
os.chown(js_path, stat.st_uid, stat.st_gid)
os.chmod(js_path, stat.st_mode)
html = html_path.read_text(encoding="utf-8")
oldv = "index-empty-video-copy.js?v=20261026-draft-primary"
newv = "index-empty-video-copy.js?v=20261027-upload-toolbar"
if html.count(oldv) != 1:
    raise SystemExit("html %s" % html.count(oldv))
hstat = html_path.stat()
html_path.write_text(html.replace(oldv, newv, 1), encoding="utf-8")
os.chown(html_path, hstat.st_uid, hstat.st_gid)
os.chmod(html_path, hstat.st_mode)
print("ok")
