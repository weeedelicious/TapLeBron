from pathlib import Path
p = Path(r'C:/Users/wuyixiang/Documents/TapLeBron/src/canvas/components/Canvas.tsx')
t = p.read_text(encoding='utf-8')
old = "const isVideoNode = data?.type === 'video'"
new = "const isVideoNode = data?.type === 'video' || data?.type === 'image'"
print('canvas', t.count(old))
assert t.count(old)==1
p.write_text(t.replace(old, new, 1), encoding='utf-8')
print('canvas ok')