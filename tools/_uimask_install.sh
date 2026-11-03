#!/bin/bash
set -euo pipefail
root=/data/wyx_root/tapflow-workbench/vendor/ui-mask-node-source
# Remove the previous mask implementation, keep host adapters and runtimes.
find "$root/server" -maxdepth 1 -type f \( -name 'uiMask*' -o -name 'ui_mask_*' -o -name 'requirements-ui-mask.txt' \) -delete
rm -rf "$root/server/ui-mask-reviewed-layouts"
rm -f "$root/src/skills/UiMaskSkill.js" "$root/src/skills/UiMaskAnimation.js" "$root/src/skills/UiMaskAppearance.js" \
  "$root/src/skills/UiMaskDocument.js" "$root/src/skills/UiMaskEditing.js" "$root/src/skills/HudRemovalSkill.js"
rm -f "$root/src/ui/UiMaskAdaptivePanel.js" "$root/src/ui/UiMaskEditor.js" "$root/src/ui/UiMaskGeometry.js" \
  "$root/src/ui/UiMaskPathDrawing.js" "$root/src/ui/UiMaskPathEditor.js" "$root/src/ui/UiMaskPathGeometry.js" \
  "$root/src/ui/UiMaskSelection.js" "$root/src/ui/UiMaskViewport.js" "$root/src/ui/UiMaskSeekPlayback.js" "$root/src/ui/ui-mask.css"
rm -f "$root/src/utils/LocalVideo.js"
cp -a /tmp/ui-mask-overlay/server/. "$root/server/"
cp -a /tmp/ui-mask-overlay/src/. "$root/src/"
mkdir -p "$root/tests"
cp -a /tmp/ui-mask-overlay/tests/. "$root/tests/"
mkdir -p "$root/.hud-research/ui-detect-models" "$root/outputs/ui-mask-panel-a-20261027"
cp -a /tmp/ui-mask-overlay/weights/ui-detect-models/. "$root/.hud-research/ui-detect-models/"
cp -a /tmp/ui-mask-overlay/weights/panel/. "$root/outputs/ui-mask-panel-a-20261027/"
cp -a /tmp/ui-mask-bridge.js /data/wyx_root/tapflow-workbench/public/ui-mask-bridge.js
python3 - <<'PY'
from pathlib import Path
p = Path("/data/wyx_root/tapflow-workbench/vendor/ui-mask-node-source/server/uiMaskApi.js")
text = p.read_text(encoding="utf-8")
old = "trainedAvailable:model.available,modelVersion:model.available?model.version:null,"
new = old + "\n            panelAvailable:panel.available,panelVersion:panel.available?panel.version:null,"
if "panelAvailable:" not in text:
    if old not in text:
        raise SystemExit("health patch anchor missing")
    text = text.replace("const model=maskDetectorConfig(root);", "const model=maskDetectorConfig(root);\n          const panel=maskPanelConfig(root);", 1)
    text = text.replace(old, new, 1)
    p.write_text(text, encoding="utf-8")
print("health patched", "panelAvailable" in p.read_text(encoding="utf-8"))
PY
python3 /tmp/_uimask_bundle_patch.py
chown -R tapflow:tapflow "$root/server" "$root/src" "$root/tests" "$root/.hud-research/ui-detect-models" "$root/outputs/ui-mask-panel-a-20261027" /data/wyx_root/tapflow-workbench/public/ui-mask-bridge.js /data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js /data/wyx_root/tapflow-workbench/public/releases/matting-rectangle-live-preview-20260811/index.html
echo INSTALL_OK
ls -lh "$root/.hud-research/ui-detect-models/hud-detector-v1-best.pt" "$root/outputs/ui-mask-panel-a-20261027/webpage-a15.pt"
