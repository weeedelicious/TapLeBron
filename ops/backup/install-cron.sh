#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

CRON_FILE="/etc/cron.d/shotflow-backups"

mkdir -p "$BACKUP_LOG_DIR"

cat > "$CRON_FILE" <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

0 3 * * * root cd $APP_ROOT && $APP_ROOT/ops/backup/mysql-full.sh >> $BACKUP_LOG_DIR/mysql-full.log 2>&1
10 * * * * root cd $APP_ROOT && $APP_ROOT/ops/backup/mysql-binlog.sh >> $BACKUP_LOG_DIR/mysql-binlog.log 2>&1
20 * * * * root cd $APP_ROOT && $APP_ROOT/ops/backup/verify.sh >> $BACKUP_LOG_DIR/verify.log 2>&1
EOF

chmod 644 "$CRON_FILE"
log "Installed cron schedule at $CRON_FILE"
