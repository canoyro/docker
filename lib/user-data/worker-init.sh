#!/bin/bash
set -euxo pipefail
for i in $(seq 1 30); do
  systemctl is-active --quiet docker && docker info >/dev/null 2>&1 && break
  sleep 5
done
systemctl is-active --quiet docker
command -v docker-credential-ecr-login >/dev/null 2>&1 || { echo "amazon-ecr-credential-helper not found — bake it into the AMI"; exit 1; }
mkdir -p /root/.docker
printf '{"credsStore":"ecr-login"}' > /root/.docker/config.json
for i in $(seq 1 60); do
  JOIN_COMMAND=$(aws ssm get-parameter --region __REGION__ --name "__WORKER_JOIN_COMMAND_PARAM__" --with-decryption --query Parameter.Value --output text 2>/dev/null) && break
  sleep 10
done
test -n "${JOIN_COMMAND:-}"
docker info --format '{{.Swarm.LocalNodeState}}' | grep -q "^active$" || $JOIN_COMMAND
