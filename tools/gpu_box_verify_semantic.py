"""在 4090 机上验证 /v1/semantic-parts。只打印摘要，绝不打印 base64 图像数据。"""
import base64, io, json, os, sys, urllib.request

PORT = os.environ.get("VERIFY_PORT", "8093")
TOKEN = os.environ.get("SUBJECT_MATTING_API_TOKEN", "")
IMAGE = sys.argv[1] if len(sys.argv) > 1 else r"C:\Shotflow\subject-matting-worker\logs\tc-test.png"

ATR = {0:"Background",1:"Hat",2:"Hair",3:"Sunglasses",4:"Upper-clothes",5:"Skirt",6:"Pants",
       7:"Dress",8:"Belt",9:"Left-shoe",10:"Right-shoe",11:"Face",12:"Left-leg",13:"Right-leg",
       14:"Left-arm",15:"Right-arm",16:"Bag",17:"Scarf"}

def post_multipart(url, path, token):
    boundary = "----shotflowverify"
    with open(path, "rb") as fh:
        payload = fh.read()
    body = b"".join([
        b"--", boundary.encode(), b"\r\n",
        b'Content-Disposition: form-data; name="file"; filename="input.png"\r\n',
        b"Content-Type: image/png\r\n\r\n", payload, b"\r\n",
        b"--", boundary.encode(), b"--\r\n",
    ])
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read().decode("utf-8"))

base = "http://127.0.0.1:" + PORT

req = urllib.request.Request(base + "/v1/semantic-parts/preload", data=b"", method="POST")
if TOKEN:
    req.add_header("Authorization", "Bearer " + TOKEN)
print("=== preload（首次会下载权重，可能要几分钟）")
with urllib.request.urlopen(req, timeout=1800) as resp:
    print(json.dumps(json.loads(resp.read().decode("utf-8")), ensure_ascii=False))

print("=== 推理", IMAGE)
data = post_multipart(base + "/v1/semantic-parts", IMAGE, TOKEN)
for key in ("modelId", "modelRevision", "labelSet", "labelCount", "width", "height",
            "inferenceWidth", "inferenceHeight", "elapsedSec"):
    print("  %-16s %s" % (key, data.get(key)))

counts = data.get("classPixelCounts") or {}
total = sum(counts.values()) or 1
print("  类别分布（原始 ATR id）：")
for k in sorted(counts, key=lambda x: -counts[x]):
    cid = int(k)
    print("    %-2s %-14s %6.2f%%" % (cid, ATR.get(cid, "?"), 100.0 * counts[k] / total))

# 真正的正确性校验：classMap 必须是单通道、尺寸等于原图、像素值全部落在 0..17
raw = base64.b64decode(data["assets"]["classMap"]["data"])
print("  classMap PNG 字节数 %d" % len(raw))
try:
    from PIL import Image
    import numpy as np
    img = Image.open(io.BytesIO(raw))
    arr = np.array(img)
    print("  classMap mode=%s size=%s dtype=%s" % (img.mode, img.size, arr.dtype))
    ok_mode = img.mode == "L"
    ok_size = img.size == (data["width"], data["height"])
    ok_range = int(arr.min()) >= 0 and int(arr.max()) <= 17
    ok_counts = int(arr.size) == total
    print("  单通道: %s | 尺寸等于原图: %s | 取值在 0..17: %s (min=%d max=%d) | 计数自洽: %s"
          % (ok_mode, ok_size, ok_range, int(arr.min()), int(arr.max()), ok_counts))
    print("  RESULT " + ("PASS" if (ok_mode and ok_size and ok_range and ok_counts) else "FAIL"))
except Exception as exc:
    print("  校验失败:", exc)
