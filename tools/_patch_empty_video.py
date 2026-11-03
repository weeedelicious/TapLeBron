from pathlib import Path
lines=Path(r'C:/Users/wuyixiang/Documents/TapLeBron/src/canvas/components/Canvas.tsx').read_text(encoding='utf-8').splitlines()
for i in range(776,786):
    print(i+1, repr(lines[i]))
