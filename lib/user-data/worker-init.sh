#!/bin/bash
set -euxo pipefail
for i in $(seq 1 60); do
  JOIN_COMMAND=$(aws ssm get-parameter --region __REGION__ --name "__WORKER_JOIN_COMMAND_PARAM__" --with-decryption --query Parameter.Value --output text 2>/dev/null) && break
  sleep 10
done
test -n "${JOIN_COMMAND:-}"
docker info --format '{{.Swarm.LocalNodeState}}' | grep -q "^active$" || $JOIN_COMMAND

rpm -q mount-s3 2>/dev/null || yum install -y https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.rpm
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
