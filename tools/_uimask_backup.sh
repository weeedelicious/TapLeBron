#!/bin/bash
set -euo pipefail
root=/data/wyx_root/tapflow-workbench
bak=$root/deploy-backups/ui-mask-20261028-rewrite
mkdir -p "$bak/server" "$bak/public" "$bak/dist"
cp -a "$root/server/uiMaskMount.js" "$bak/server/"
cp -a "$root/public/ui-mask-bridge.js" "$bak/public/"
cp -a "$root/vendor/ui-mask-node-source/server" "$bak/"
cp -a "$root/vendor/ui-mask-node-source/src" "$bak/"
cp -a "$root/dist/assets/index-empty-video-copy.js" "$bak/dist/"
echo BACKUP_OK "$bak"
