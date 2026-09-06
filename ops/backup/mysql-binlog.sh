#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

JOB_NAME="mysql-binlog"
TARGET_DIR="$BACKUP_ROOT_DIR/mysql/binlog"
MANIFEST_FILE="$TARGET_DIR/latest-master-status.txt"

mkdir -p "$TARGET_DIR"

LOG_BIN_STATE="$(mysql_exec "SHOW VARIABLES LIKE 'log_bin'" | awk '{print $2}')"
if [[ "$LOG_BIN_STATE" != "ON" ]]; then
  fail_job "$JOB_NAME" 'MySQL binary logging is not enabled'
fi

LOG_BIN_BASE="$(mysql_exec "SHOW VARIABLES LIKE 'log_bin_basename'" | awk '{print $2}')"
if [[ -z "$LOG_BIN_BASE" ]]; then
  fail_job "$JOB_NAME" 'Could not read MySQL log_bin_basename'
fi
BINLOG_PREFIX="$(basename "$LOG_BIN_BASE")"

mysql_exec 'FLUSH BINARY LOGS' >/dev/null 2>&1 || fail_job "$JOB_NAME" 'FLUSH BINARY LOGS failed'

CURRENT_LOG="$(mysql_exec 'SHOW MASTER STATUS' | awk 'NR==1 {print $1}')"
if [[ -z "$CURRENT_LOG" ]]; then
  fail_job "$JOB_NAME" 'Could not determine current master log'
fi

BINLOG_DIR="$(dirname "$LOG_BIN_BASE")"
COPIED=0
while read -r LOG_NAME _; do
  [[ -z "${LOG_NAME:-}" ]] && continue
  if [[ "$LOG_NAME" == "$CURRENT_LOG" ]]; then
    continue
  fi
  SRC_FILE="$BINLOG_DIR/$LOG_NAME"
  DEST_FILE="$TARGET_DIR/$LOG_NAME"
  if [[ ! -f "$SRC_FILE" ]]; then
    continue
  fi
  if [[ ! -f "$DEST_FILE" ]] || [[ "$(stat -c %s "$SRC_FILE")" != "$(stat -c %s "$DEST_FILE" 2>/dev/null || echo -1)" ]]; then
    cp -a "$SRC_FILE" "$DEST_FILE"
    COPIED=$((COPIED + 1))
  fi
done < <(mysql_exec 'SHOW BINARY LOGS')

{
  printf 'generated_at=%s\n' "$(timestamp_now)"
  mysql_exec 'SHOW MASTER STATUS'
} > "$MANIFEST_FILE" || fail_job "$JOB_NAME" 'Failed to write master status manifest'

find "$TARGET_DIR" -maxdepth 1 -type f -name "${BINLOG_PREFIX}.*" -mtime "+${BACKUP_RETENTION_DAYS}" -delete || true

succeed_job "$JOB_NAME" "Binary log archival complete: copied ${COPIED} file(s), current log ${CURRENT_LOG}"
