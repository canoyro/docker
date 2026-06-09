#!/bin/bash
set -euxo pipefail
for i in $(seq 1 30); do
  systemctl is-active --quiet docker && docker info >/dev/null 2>&1 && break
  sleep 5
done
systemctl is-active --quiet docker
apt-get install -y amazon-ecr-credential-helper
mkdir -p /root/.docker
echo '{"credsStore":"ecr-login"}' > /root/.docker/config.json
for i in $(seq 1 60); do
  JOIN_COMMAND=$(aws ssm get-parameter --region __REGION__ --name "__WORKER_JOIN_COMMAND_PARAM__" --with-decryption --query Parameter.Value --output text 2>/dev/null) && break
  sleep 10
done
test -n "${JOIN_COMMAND:-}"
docker info --format '{{.Swarm.LocalNodeState}}' | grep -q "^active$" || $JOIN_COMMAND
