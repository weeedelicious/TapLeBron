from pathlib import Path
p = Path(r'C:/Users/wuyixiang/Documents/TapLeBron/public/home/index.html')
t = p.read_text(encoding='utf-8')
old = "    ['三维导演台','在三维空间里排演镜头与角色','workflow-demo-08.mp4']\n  ];"
new = "    ['三维导演台','在三维空间里排演镜头与角色','workflow-demo-08.mp4'],\n    ['视频转深度','把画面转成可查看的深度视频','workflow-demo-09.mp4']\n  ];"
print('count', t.count(old))
assert t.count(old)==1
t = t.replace(old, new, 1)
t = t.replace('let position=3,target=null', 'let position=4,target=null', 1)
p.write_text(t, encoding='utf-8')
print('ok')