#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

JOB_NAME="mysql-full"
DB_NAME="${DB_NAME:?DB_NAME is required}"
STAMP="$(date +%F-%H%M%S)"
TARGET_DIR="$BACKUP_ROOT_DIR/mysql/full/$(date +%Y/%m)"
OUTPUT_FILE="$TARGET_DIR/shotflow-${DB_NAME}-bundle-${STAMP}.sql.gz"
TMP_FILE="${OUTPUT_FILE}.tmp"
META_FILE="$TARGET_DIR/shotflow-${DB_NAME}-bundle-${STAMP}.meta.txt"

mkdir -p "$TARGET_DIR"

if ! mysql_exec 'SELECT 1' >/dev/null 2>&1; then
  fail_job "$JOB_NAME" 'Unable to connect to MySQL before full backup'
fi

declare -a DB_NAMES=()

append_db_name() {
  local name="${1:-}"
  [[ -z "$name" ]] && return
  if [[ ! "$name" =~ ^[A-Za-z0-9_]+$ ]]; then
    log "Skipping invalid database name: $name"
    return
  fi
  local existing
  for existing in "${DB_NAMES[@]}"; do
    [[ "$existing" == "$name" ]] && return
  done
  if [[ -z "$(mysql_exec "SHOW DATABASES LIKE '$name'")" ]]; then
    log "Skipping missing database: $name"
    return
  fi
  DB_NAMES+=("$name")
}

append_db_name "$DB_NAME"
append_db_name "${CANVAS_DB_NAME:-}"
append_db_name "${CONTENT_DB_NAME:-}"
append_db_name "${USAGE_DB_NAME:-${DB_NAME}_usage}"
append_db_name "${PROJECT_CATALOG_MAIN_DB:-}"
append_db_name "${PROJECT_CATALOG_NAME:-}"

if (( ${#DB_NAMES[@]} == 0 )); then
  fail_job "$JOB_NAME" 'No MySQL databases selected for full backup'
fi

log "Starting full MySQL backup into $OUTPUT_FILE"
log "Databases: ${DB_NAMES[*]}"

{
  printf 'generated_at=%s\n' "$(timestamp_now)"
  printf 'databases=%s\n' "${DB_NAMES[*]}"
  mysql_exec "SHOW MASTER STATUS"
} > "$META_FILE" || fail_job "$JOB_NAME" 'Failed to capture master status metadata'

if ! mysqldump_exec \
  --single-transaction \
  --quick \
  --routines \
  --events \
  --triggers \
  --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 \
  --databases "${DB_NAMES[@]}" | gzip -1 > "$TMP_FILE"; then
  rm -f "$TMP_FILE"
  fail_job "$JOB_NAME" 'mysqldump or compression failed'
fi

mv "$TMP_FILE" "$OUTPUT_FILE"

find "$BACKUP_ROOT_DIR/mysql/full" -type f -mtime "+${BACKUP_RETENTION_DAYS}" -delete || true
find "$BACKUP_ROOT_DIR/mysql/full" -type d -empty -delete || true

SIZE="$(du -h "$OUTPUT_FILE" | awk '{print $1}')"
succeed_job "$JOB_NAME" "Full MySQL backup complete: ${OUTPUT_FILE} (${SIZE}); databases=${DB_NAMES[*]}"
