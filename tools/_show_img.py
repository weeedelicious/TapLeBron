from pathlib import Path
lines = Path(r"C:/Users/wuyixiang/Documents/TapLeBron/server/canvasRoutes.js").read_text(encoding="utf-8").splitlines()
for i in range(4260, 4350):
    print(f"{i+1}|{lines[i]}")
print("---- preview call ----")
for i in range(6840, 6920):
    print(f"{i+1}|{lines[i]}")
