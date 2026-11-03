from pathlib import Path
lines = Path(r"C:/Users/wuyixiang/Documents/TapLeBron/src/canvas/components/Canvas.tsx").read_text(encoding="utf-8").splitlines()
for i in range(2760, 2920):
    print(f"{i+1}|{lines[i]}")
