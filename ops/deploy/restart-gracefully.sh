#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-tapflow-workbench.service}"
APP_DIR="${APP_DIR:-/data/wyx_root/tapflow-workbench}"

cd "$APP_DIR"
npm run build
systemctl restart "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME"

echo "$SERVICE_NAME restarted after graceful task drain"
