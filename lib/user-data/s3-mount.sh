#!/bin/bash
set -euxo pipefail
command -v mount-s3 >/dev/null 2>&1 || { echo "mount-s3 not found — bake it into the AMI"; exit 1; }
grep -q 'user_allow_other' /etc/fuse.conf || echo 'user_allow_other' >> /etc/fuse.conf
mkdir -p /mnt/s3-shared /tmp/s3-cache
cat > /etc/systemd/system/s3-mount.service <<'SVCEOF'
[Unit]
Description=S3 Mountpoint for shared storage
After=network.target

[Service]
Type=forking
ExecStart=/usr/bin/mount-s3 __S3_BUCKET_NAME__ /mnt/s3-shared --cache /tmp/s3-cache --max-cache-size 1024 --allow-other
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF
systemctl daemon-reload
systemctl enable --now s3-mount.service
