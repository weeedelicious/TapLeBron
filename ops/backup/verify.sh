#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

JOB_NAME="backup-verify"
FULL_BACKUP_MAX_AGE_HOURS="${FULL_BACKUP_MAX_AGE_HOURS:-36}"
BINLOG_BACKUP_MAX_AGE_MINUTES="${BINLOG_BACKUP_MAX_AGE_MINUTES:-120}"

newest_file() {
  local search_dir="$1"
  local search_name="$2"
  find "$search_dir" -type f -name "$search_name" 2>/dev/null | sort | tail -n 1
}

age_minutes() {
  local file_path="$1"
  python3 - "$file_path" <<'PY'
from pathlib import Path
import os
import sys
import time

path = Path(sys.argv[1])
if not path.exists():
    print(-1)
else:
    print(int((time.time() - path.stat().st_mtime) / 60))
PY
}

if [[ "$(mysql_exec "SHOW VARIABLES LIKE 'log_bin'" | awk '{print $2}')" != "ON" ]]; then
  fail_job "$JOB_NAME" 'MySQL binlog is disabled'
fi

BINLOG_BASE="$(mysql_exec "SHOW VARIABLES LIKE 'log_bin_basename'" | awk '{print $2}')"
BINLOG_PREFIX="$(basename "$BINLOG_BASE")"

FULL_FILE="$(newest_file "$BACKUP_ROOT_DIR/mysql/full" '*.sql.gz')"
if [[ -z "$FULL_FILE" ]]; then
  fail_job "$JOB_NAME" 'No full MySQL backup file found'
fi

FULL_AGE_MINUTES="$(age_minutes "$FULL_FILE")"
if (( FULL_AGE_MINUTES < 0 || FULL_AGE_MINUTES > FULL_BACKUP_MAX_AGE_HOURS * 60 )); then
  fail_job "$JOB_NAME" "Latest full backup is too old: ${FULL_FILE} (${FULL_AGE_MINUTES} minutes)"
fi

BINLOG_FILE="$(newest_file "$BACKUP_ROOT_DIR/mysql/binlog" "${BINLOG_PREFIX}.*")"
if [[ -z "$BINLOG_FILE" ]]; then
  fail_job "$JOB_NAME" 'No archived MySQL binlog file found'
fi

BINLOG_AGE_MINUTES="$(age_minutes "$BINLOG_FILE")"
if (( BINLOG_AGE_MINUTES < 0 || BINLOG_AGE_MINUTES > BINLOG_BACKUP_MAX_AGE_MINUTES )); then
  fail_job "$JOB_NAME" "Latest archived binlog is too old: ${BINLOG_FILE} (${BINLOG_AGE_MINUTES} minutes)"
fi

succeed_job "$JOB_NAME" "Backups look healthy: full=${FULL_FILE}, binlog=${BINLOG_FILE}"
