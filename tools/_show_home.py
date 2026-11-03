from pathlib import Path
t=Path(r'C:/Users/wuyixiang/Documents/TapLeBron/public/home/index.html').read_text(encoding='utf-8')
i=t.find("workflow-demo-08")
print(t[i-120:i+80].encode('unicode_escape').decode())
