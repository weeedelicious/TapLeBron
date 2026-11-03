#!/bin/bash
set -euo pipefail
node --input-type=module --check < /data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js
python3 - <<'PY'
from pathlib import Path
text = Path("/data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js").read_text(encoding="utf-8")
start = text.find("function ZmaskNode(")
end = text.find("const D5t=", start)
print("node len", end - start)
for needle in ["ShotflowUiMask.mount", "addNodeAt", "contentWidth:640"]:
    print(needle, needle in text)
PY
systemctl restart tapflow-workbench.service
sleep 3
systemctl is-active tapflow-workbench.service
curl -sS -o /tmp/shotflow.html -w 'home %{http_code} %{size_download}\n' http://127.0.0.1:8084/Shotflow
curl -sS -o /tmp/uimask-health.json -w 'health %{http_code}\n' http://127.0.0.1:8084/api/ui-mask/health
echo '--- health body ---'
head -c 400 /tmp/uimask-health.json; echo
journalctl -u tapflow-workbench.service -n 40 --no-pager | grep -E 'ui mask|uiMask' || true
