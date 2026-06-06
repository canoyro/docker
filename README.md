# Docker Swarm CDK Project

This project deploys a Docker Swarm environment on AWS using CDK TypeScript. The stack uses existing VPC/subnet inputs from `parameters.json`, creates manager and worker Auto Scaling Groups, configures private VPC endpoints, and includes a small internal API service that can be pushed to ECR and deployed to Swarm.

## Stack Resources

The CDK stack creates:

- Docker manager Auto Scaling Group
- Docker worker Auto Scaling Group
- Security groups for Swarm manager/worker traffic
- Private route table association for the Docker subnet
- SSM, EC2 Messages, and SSM Messages interface endpoints
- ECR API and ECR Docker interface endpoints
- S3 gateway endpoint for ECR image layers
- ECR repository named `internal-file-api`
- EC2 key pair for SSH
- EC2 instance role with SSM, ECR pull, and ASG health reporting permissions
- SSM parameters used for Swarm bootstrap and join commands

## Parameters

Update `parameters.json` before deploying:

```json
{
  "vpcId": "vpc-...",
  "subnetId": "subnet-...",
  "availabilityZone": "ap-southeast-2a",
  "amiId": "ami-...",
  "instanceType": "t3.micro"
}
```

The AMI should already have Docker and AWS CLI installed. The private subnet has no NAT in the current design, so instances rely on VPC endpoints for SSM and ECR access.

## Deploy The Stack

Use Git Bash style commands:

```bash
npm install
./node_modules/.bin/tsc --noEmit
npx cdk diff
npx cdk deploy
```

After deploy, verify endpoints:

```bash
aws ec2 describe-vpc-endpoints \
  --region ap-southeast-2 \
  --filters Name=vpc-id,Values=<vpc-id> \
  --output table
```

Expected services include:

```text
com.amazonaws.ap-southeast-2.ssm
com.amazonaws.ap-southeast-2.ec2messages
com.amazonaws.ap-southeast-2.ssmmessages
com.amazonaws.ap-southeast-2.ecr.api
com.amazonaws.ap-southeast-2.ecr.dkr
com.amazonaws.ap-southeast-2.s3
```

## Swarm Bootstrap

Managers use user data to initialize or join the swarm. The first manager initializes Docker Swarm and writes join commands to SSM:

```text
/docker-swarm/DockerStack/bootstrap-manager-ip
/docker-swarm/DockerStack/manager-join-command
/docker-swarm/DockerStack/worker-join-command
```

Worker nodes read the worker join command from SSM and join the swarm automatically.

Manager nodes also install a `systemd` timer that periodically republishes the current manager private IP and fresh join commands:

```bash
systemctl status docker-manager-ssm-refresh.timer
sudo journalctl -u docker-manager-ssm-refresh.service -n 50 --no-pager
```

## Auto Scaling

The manager ASG is configured for quorum:

```text
manager min: 3
manager max: 4
```

The worker ASG scales horizontally:

```text
worker min: 2
worker max: 4
CPU target scaling: 40%
```

The ASGs do not set fixed `desiredCapacity`; scaling policies can adjust desired capacity between min and max.

Both ASGs have EC2 health checks and a Docker health timer. If Docker stops responding for repeated checks, the instance marks itself unhealthy so the ASG can replace it.

## Swarm Considerations

Docker Swarm managers require quorum. Use an odd number of managers:

```text
1 manager: okay for testing, no high availability
2 managers: avoid, losing 1 loses quorum
3 managers: recommended baseline
5 managers: larger clusters
```

If managers run application tasks, control-plane stability can be affected. For a more production-like setup, drain managers and run services on workers:

```bash
docker node update --availability drain <manager-node>
```

Remove down workers:

```bash
docker node rm --force <worker-node-id>
```

Remove down managers only after demotion:

```bash
docker node demote <manager-node-id>
docker node rm --force <manager-node-id>
```

## Internal API Service

The repo includes a small API under:

```text
docker/internal-file-api/
```

Endpoints:

```text
/health
/read
/write?value=test
```

The Swarm stack file is:

```text
docker/internal-file-api-stack.yml
```

It uses the ECR image:

```yaml
image: 581145854871.dkr.ecr.ap-southeast-2.amazonaws.com/internal-file-api:latest
```

## Build And Push The Internal API

The ECR repository is created by CDK. After `npx cdk deploy`, push the image:

```bash
cd docker/internal-file-api
chmod +x push-to-ecr.sh
./push-to-ecr.sh
```

Optional overrides:

```bash
REGION=ap-southeast-2 REPO_NAME=internal-file-api IMAGE_TAG=latest ./push-to-ecr.sh
```

Confirm the image exists:

```bash
aws ecr describe-images \
  --region ap-southeast-2 \
  --repository-name internal-file-api \
  --query 'imageDetails[].imageTags' \
  --output table
```

## Deploy The Internal API To Swarm

From a Swarm manager:

```bash
aws ecr get-login-password --region ap-southeast-2 | docker login \
  --username AWS \
  --password-stdin 581145854871.dkr.ecr.ap-southeast-2.amazonaws.com

docker stack deploy \
  --with-registry-auth \
  -c docker/internal-file-api-stack.yml \
  internal-api
```

Check service state:

```bash
docker service ls
docker service ps internal-api_internal-file-api --no-trunc
```

Test the API:

```bash
curl http://localhost:8080/
curl http://localhost:8080/health
curl "http://localhost:8080/write?value=hello"
curl http://localhost:8080/read
```

Scale the service:

```bash
docker service scale internal-api_internal-file-api=4
```

## Troubleshooting

If tasks are rejected with `No such image`, confirm:

- The ECR repository exists.
- The `latest` image was pushed.
- ECR API, ECR Docker, and S3 endpoints are deployed.
- The EC2 instance role has ECR pull permissions.
- The deploy used `--with-registry-auth`.

Useful checks:

```bash
docker service ps internal-api_internal-file-api --no-trunc
docker service logs internal-api_internal-file-api
docker pull 581145854871.dkr.ecr.ap-southeast-2.amazonaws.com/internal-file-api:latest
```

If Swarm reports no leader, manager quorum was lost. With 3 managers, at least 2 must be online. If quorum survives, Swarm elects a new leader automatically.

## Repo Hygiene

Generated and dependency files are ignored:

```text
node_modules/
cdk.out/
cdk.out.verify/
*.js
*.d.ts
```

Install dependencies with:

```bash
npm install
```

Clean local generated files if needed:

```bash
rm -rf cdk.out cdk.out.verify
rm -f bin/*.js bin/*.d.ts lib/*.js lib/*.d.ts test/*.js test/*.d.ts
```
