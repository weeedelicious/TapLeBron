p = "/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js"
text = open(p, encoding="utf-8", errors="replace").read()
needles = ["useCanvasStore", "addNodeAt", "const st=", "let st=", "st=N", "window.Shotflow"]
for n in needles:
    print(n, text.find(n))
# find assignments that look like canvas store
idx = 0
count = 0
while count < 15:
    i = text.find(".getState()", idx)
    if i < 0:
        break
    start = max(0, i - 40)
    snippet = text[start:i + 20]
    if "addNode" in text[i:i + 200] or "nodes" in text[i:i + 80]:
        print("GET", i, snippet.replace("\n", " "))
        count += 1
    idx = i + 11
print("--- addNode nearby ---")
j = text.find("addNodeAt")
print("addNodeAt", j)
print(text[j - 120:j + 80] if j >= 0 else "none")
