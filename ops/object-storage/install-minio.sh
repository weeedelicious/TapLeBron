#!/usr/bin/env bash
set -euo pipefail

MINIO_USER="${MINIO_USER:-minio}"
MINIO_GROUP="${MINIO_GROUP:-minio}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
MINIO_DATA_DIR="${MINIO_DATA_DIR:-/data/minio/data}"
MINIO_PORT="${MINIO_PORT:-9000}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9001}"

if ! id "$MINIO_USER" >/dev/null 2>&1; then
  if ! getent group "$MINIO_GROUP" >/dev/null 2>&1; then
    groupadd --system "$MINIO_GROUP"
  fi
  useradd --system --gid "$MINIO_GROUP" --home /nonexistent --shell /usr/sbin/nologin "$MINIO_USER"
fi

mkdir -p /etc/minio "$MINIO_DATA_DIR"
chown -R "$MINIO_USER:$MINIO_GROUP" /etc/minio "$MINIO_DATA_DIR"

curl -fsSL https://dl.min.io/server/minio/release/linux-amd64/minio -o /usr/local/bin/minio
chmod +x /usr/local/bin/minio

cat > /etc/minio/shotflow.env <<EOF
MINIO_ROOT_USER=$MINIO_ROOT_USER
MINIO_ROOT_PASSWORD=$MINIO_ROOT_PASSWORD
MINIO_VOLUMES=$MINIO_DATA_DIR
MINIO_OPTS=--address :$MINIO_PORT --console-address :$MINIO_CONSOLE_PORT
EOF

cat > /etc/systemd/system/minio-shotflow.service <<EOF
[Unit]
Description=MinIO for Shotflow
After=network-online.target
Wants=network-online.target

[Service]
User=$MINIO_USER
Group=$MINIO_GROUP
EnvironmentFile=/etc/minio/shotflow.env
ExecStart=/usr/local/bin/minio server \$MINIO_VOLUMES \$MINIO_OPTS
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now minio-shotflow
systemctl is-active minio-shotflow >/dev/null
echo "MinIO installed and running on ports ${MINIO_PORT}/${MINIO_CONSOLE_PORT}"
