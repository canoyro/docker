#!/bin/bash
set -euo pipefail
docker info --format '{{.Swarm.LocalNodeState}}' | grep -q "^active$"
docker info --format '{{.Swarm.ControlAvailable}}' | grep -q "^true$"
TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
PRIVATE_IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
MANAGER_TOKEN=$(docker swarm join-token manager -q)
WORKER_TOKEN=$(docker swarm join-token worker -q)
aws ssm put-parameter --region "$AWS_REGION" --name "__BOOTSTRAP_MANAGER_IP_PARAM__" --type String --overwrite --value "$PRIVATE_IP"
aws ssm put-parameter --region "$AWS_REGION" --name "__MANAGER_JOIN_COMMAND_PARAM__" --type SecureString --overwrite --value "docker swarm join --token $MANAGER_TOKEN $PRIVATE_IP:2377"
aws ssm put-parameter --region "$AWS_REGION" --name "__WORKER_JOIN_COMMAND_PARAM__" --type SecureString --overwrite --value "docker swarm join --token $WORKER_TOKEN $PRIVATE_IP:2377"
