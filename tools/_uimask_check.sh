#!/bin/bash
set -euo pipefail
cd /data/wyx_root/tapflow-workbench/vendor/ui-mask-node-source/server
sudo -u tapflow ../.hud-research/ui-detect-venv/bin/python -c 'import ui_mask_trained,ui_mask_recovery,ui_mask_compass,ui_mask_detect,ui_mask_local_evidence; print("detect imports ok")'
sudo -u tapflow ../.hud-research/venv/bin/python -m py_compile ui_mask_worker.py ui_mask_core.py ui_mask_detect.py ui_mask_merge.py ui_mask_motion.py ui_mask_compass.py ui_mask_recovery.py ui_mask_trained.py
node --check /data/wyx_root/tapflow-workbench/server/uiMaskMount.js
node --check /data/wyx_root/tapflow-workbench/dist/assets/index-empty-video-copy.js
echo CHECK_OK
