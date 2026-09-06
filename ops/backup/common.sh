#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${SHOTFLOW_ENV_FILE:-$APP_ROOT/.env}"

if [[ -f "$ENV_FILE" ]]; then
  eval "$(
    python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import shlex
import sys

env_file = Path(sys.argv[1])
for raw in env_file.read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    print(f"export {key.strip()}={shlex.quote(value.strip())}")
PY
  )"
fi

BACKUP_ROOT_DIR="${BACKUP_ROOT_DIR:-$APP_ROOT/data/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_ALERT_WEBHOOK_URL="${BACKUP_ALERT_WEBHOOK_URL:-}"
BACKUP_STATUS_DIR="$BACKUP_ROOT_DIR/status"
BACKUP_LOG_DIR="$BACKUP_ROOT_DIR/logs"

mkdir -p "$BACKUP_ROOT_DIR" "$BACKUP_STATUS_DIR" "$BACKUP_LOG_DIR"

timestamp_now() {
  date --iso-8601=seconds
}

log() {
  printf '[%s] %s\n' "$(timestamp_now)" "$*"
}

mysql_can_socket_auth() {
  mysql --protocol=socket -Nse 'SELECT 1' >/dev/null 2>&1
}

mysql_exec() {
  local sql="$1"
  if mysql_can_socket_auth; then
    mysql --protocol=socket -Nse "$sql"
    return
  fi
  : "${DB_HOST:=127.0.0.1}"
  : "${DB_PORT:=3306}"
  : "${DB_USER:?DB_USER is required for mysql_exec fallback}"
  MYSQL_PWD="${DB_PASSWORD:-}" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -Nse "$sql"
}

mysqldump_exec() {
  if mysql_can_socket_auth; then
    mysqldump --protocol=socket "$@"
    return
  fi
  : "${DB_HOST:=127.0.0.1}"
  : "${DB_PORT:=3306}"
  : "${DB_USER:?DB_USER is required for mysqldump_exec fallback}"
  MYSQL_PWD="${DB_PASSWORD:-}" mysqldump -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$@"
}

write_status() {
  local job_name="$1"
  local status="$2"
  local message="$3"
  python3 - "$BACKUP_STATUS_DIR/${job_name}.json" "$job_name" "$status" "$message" <<'PY'
from pathlib import Path
import json
import sys
from datetime import datetime, timezone

target, job_name, status, message = sys.argv[1:5]
payload = {
    "job": job_name,
    "status": status,
    "message": message,
    "updatedAt": datetime.now(timezone.utc).isoformat(),
}
Path(target).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
PY
}

notify_alert() {
  local title="$1"
  local message="$2"
  if [[ -z "$BACKUP_ALERT_WEBHOOK_URL" ]]; then
    return
  fi
  python3 - "$BACKUP_ALERT_WEBHOOK_URL" "$title" "$message" <<'PY'
import json
import sys
import urllib.request

url, title, message = sys.argv[1:4]
payload = {
    "msg_type": "text",
    "content": {
        "text": f"{title}\n{message}"
    }
}
req = urllib.request.Request(
    url,
    data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    headers={"Content-Type": "application/json; charset=utf-8"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=15) as response:
    response.read()
PY
}

fail_job() {
  local job_name="$1"
  local message="$2"
  write_status "$job_name" "failed" "$message"
  log "ERROR: $message"
  notify_alert "Shotflow backup failed: ${job_name}" "$message" || true
  exit 1
}

succeed_job() {
  local job_name="$1"
  local message="$2"
  write_status "$job_name" "ok" "$message"
  log "$message"
}
