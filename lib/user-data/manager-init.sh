#!/bin/bash
set -euxo pipefail
for i in $(seq 1 30); do
  systemctl is-active --quiet docker && docker info >/dev/null 2>&1 && break
  sleep 5
done
systemctl is-active --quiet docker
apt-get update -y
apt-get install -y amazon-ecr-credential-helper
mkdir -p /root/.docker
printf '{"credsStore":"ecr-login"}' > /root/.docker/config.json
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
PRIVATE_IP=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
publish_swarm_params() {
  MANAGER_TOKEN=$(docker swarm join-token manager -q)
  WORKER_TOKEN=$(docker swarm join-token worker -q)
  aws ssm put-parameter --region __REGION__ --name "__BOOTSTRAP_MANAGER_IP_PARAM__" --type String --overwrite --value "$PRIVATE_IP"
  aws ssm put-parameter --region __REGION__ --name "__MANAGER_JOIN_COMMAND_PARAM__" --type SecureString --overwrite --value "docker swarm join --token $MANAGER_TOKEN $PRIVATE_IP:2377"
  aws ssm put-parameter --region __REGION__ --name "__WORKER_JOIN_COMMAND_PARAM__" --type SecureString --overwrite --value "docker swarm join --token $WORKER_TOKEN $PRIVATE_IP:2377"
}
init_swarm() {
  docker info --format '{{.Swarm.LocalNodeState}}' | grep -q "^active$" || docker swarm init --advertise-addr "$PRIVATE_IP"
  publish_swarm_params
}
if aws ssm put-parameter --region __REGION__ --name "__BOOTSTRAP_MANAGER_IP_PARAM__" --type String --value "$PRIVATE_IP" --no-overwrite; then
  init_swarm
else
  for i in $(seq 1 60); do MANAGER_JOIN_COMMAND=$(aws ssm get-parameter --region __REGION__ --name "__MANAGER_JOIN_COMMAND_PARAM__" --with-decryption --query Parameter.Value --output text 2>/dev/null) && break; sleep 10; done
  if [ -n "${MANAGER_JOIN_COMMAND:-}" ]; then
    docker info --format '{{.Swarm.LocalNodeState}}' | grep -q "^active$" || $MANAGER_JOIN_COMMAND || {
      aws ssm delete-parameter --region __REGION__ --name "__BOOTSTRAP_MANAGER_IP_PARAM__" 2>/dev/null || true
      init_swarm
    }
  else
    init_swarm
  fi
fi
docker info --format '{{.Swarm.LocalNodeState}}' | grep -q "^active$" && publish_swarm_params
