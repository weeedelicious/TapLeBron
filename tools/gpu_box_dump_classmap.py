"""Run /v1/semantic-parts on 8093 and dump the raw classMap PNG to disk."""
import base64, json, os, sys, urllib.request
PORT = os.environ.get("VERIFY_PORT", "8093")
TOKEN = os.environ.get("SUBJECT_MATTING_API_TOKEN", "")
IMAGE = sys.argv[1]
OUT = sys.argv[2]

def post(url, path, token):
    b = "----shotflowdump"
    with open(path, "rb") as fh:
        payload = fh.read()
    body = b"".join([b"--", b.encode(), b"\r\n",
        b'Content-Disposition: form-data; name="file"; filename="input.png"\r\n',
        b"Content-Type: image/png\r\n\r\n", payload, b"\r\n", b"--", b.encode(), b"--\r\n"])
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "multipart/form-data; boundary=" + b)
    if token: req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read().decode("utf-8"))

d = post("http://127.0.0.1:" + PORT + "/v1/semantic-parts", IMAGE, TOKEN)
with open(OUT, "wb") as fh:
    fh.write(base64.b64decode(d["assets"]["classMap"]["data"]))
print("width=%s height=%s elapsed=%s labelSet=%s" % (d["width"], d["height"], d["elapsedSec"], d["labelSet"]))
print("classMap saved -> " + OUT)
