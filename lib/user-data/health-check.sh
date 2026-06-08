#!/bin/bash
set -u
FAIL_DIR=/var/lib/docker-asg-healthcheck
FAIL_FILE="$FAIL_DIR/failures"
mkdir -p "$FAIL_DIR"
if systemctl is-active --quiet docker && timeout 10 docker info >/dev/null 2>&1; then
  echo 0 > "$FAIL_FILE"
  exit 0
fi
FAILURES=0
if [ -f "$FAIL_FILE" ]; then
  FAILURES=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
fi
FAILURES=$((FAILURES + 1))
echo "$FAILURES" > "$FAIL_FILE"
if [ "$FAILURES" -lt 3 ]; then
  exit 0
fi
TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
aws autoscaling set-instance-health --region "$AWS_REGION" --instance-id "$INSTANCE_ID" --health-status Unhealthy --should-respect-grace-period
