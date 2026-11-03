from pathlib import Path
q = chr(34)
p = Path('/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js')
t = p.read_text(encoding='utf-8')
old1 = 'emptyVideo&&copied&&copied.type===' + q + 'video' + q
new1 = 'emptyVideo&&copied&&(copied.type===' + q + 'video' + q + '||copied.type===' + q + 'image' + q + ')'
old2 = 'g?.type===' + q + 'video' + q + '&&c.jsx'
new2 = '(g?.type===' + q + 'video' + q + '||g?.type===' + q + 'image' + q + ')&&c.jsx'
old3 = 'g?.type===' + q + 'video' + q + '?456'
new3 = '(g?.type===' + q + 'video' + q + '||g?.type===' + q + 'image' + q + ')?456'
for name, old, new in [('strip', old1, new1), ('btn', old2, new2), ('pos', old3, new3)]:
    print(name, t.count(old))
    assert t.count(old)==1, name
    t = t.replace(old, new, 1)
p.write_text(t, encoding='utf-8')
html = Path('/data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html')
h = html.read_text(encoding='utf-8')
oldv = 'index-empty-video-copy.js?v=20261022-empty-copy'
newv = 'index-empty-video-copy.js?v=20261022-empty-image'
print('html', h.count(oldv))
assert h.count(oldv)==1
html.write_text(h.replace(oldv, newv, 1), encoding='utf-8')
print('ok')