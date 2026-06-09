#!/bin/bash
set -euxo pipefail
if command -v mount-s3 >/dev/null 2>&1; then
  : # already installed
elif command -v apt-get >/dev/null 2>&1; then
  curl -fsSL https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.deb -o /tmp/mount-s3.deb
  apt-get install -y /tmp/mount-s3.deb
else
  yum install -y https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.rpm
fi
mkdir -p /mnt/s3-shared /tmp/s3-cache
cat > /etc/systemd/system/s3-mount.service <<'SVCEOF'
[Unit]
Description=S3 Mountpoint for shared storage
After=network.target

[Service]
Type=forking
ExecStart=/usr/bin/mount-s3 __S3_BUCKET_NAME__ /mnt/s3-shared --cache /tmp/s3-cache --maximum-cache-size 1GiB --allow-other
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF
systemctl daemon-reload
systemctl enable --now s3-mount.service
