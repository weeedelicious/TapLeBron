from pathlib import Path
import os, subprocess
p = Path("/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js")
html_path = Path("/data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html")
text = p.read_text(encoding="utf-8")
old = '(re&&re.draftTaskId)||Object.values(e._assetGenerationMeta||{}).map(function(x){return x&&x.draftTaskId}).find(Boolean)'
print("fallback", text.count(old))
if text.count(old) != 2:
    raise SystemExit("fallback count")
text = text.replace(old, '(re&&re.draftTaskId)')
old_hint = "\u6837\u7247\u5b8c\u6210\u540e\uff0c\u8fd9\u91cc\u4f1a\u51fa\u73b0 1080P \u6210\u7247\u6309\u94ae"
new_hint = "\u8bf7\u5148\u628a\u8981\u8f6c\u6210\u7247\u7684\u90a3\u6761 480P \u6837\u7247\u8bbe\u4e3a\u4e3b\u89c6\u9891"
print("hint", text.count(old_hint))
if text.count(old_hint) != 1:
    raise SystemExit("hint")
text = text.replace(old_hint, new_hint, 1)
stat = p.stat()
p.write_text(text, encoding="utf-8")
Path("/tmp/sf-draft-id.mjs").write_text(text, encoding="utf-8")
result = subprocess.run(["node", "--check", "/tmp/sf-draft-id.mjs"], capture_output=True, text=True)
print("check", result.returncode)
if result.returncode != 0:
    print(result.stderr[-500:])
    raise SystemExit("bad")
os.chown(p, stat.st_uid, stat.st_gid)
os.chmod(p, stat.st_mode)
html = html_path.read_text(encoding="utf-8")
oldv = "index-empty-video-copy.js?v=20261026-draft-final"
newv = "index-empty-video-copy.js?v=20261026-draft-primary"
print("html", html.count(oldv))
if html.count(oldv) != 1:
    raise SystemExit("html version")
hstat = html_path.stat()
html_path.write_text(html.replace(oldv, newv, 1), encoding="utf-8")
os.chown(html_path, hstat.st_uid, hstat.st_gid)
os.chmod(html_path, hstat.st_mode)
print("ok")
