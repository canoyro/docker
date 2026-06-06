import * as cdk from 'aws-cdk-lib/core';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

interface DockerParams {
  vpcId: string;
  subnetId: string;
  availabilityZone: string;
  amiId: string;
  instanceType: string;
}

const params: DockerParams = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../parameters.json'), 'utf-8')
);

export class DockerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bootstrapManagerIpParameterName = `/docker-swarm/${cdk.Stack.of(this).stackName}/bootstrap-manager-ip`;
    const managerJoinCommandParameterName = `/docker-swarm/${cdk.Stack.of(this).stackName}/manager-join-command`;
    const workerJoinCommandParameterName = `/docker-swarm/${cdk.Stack.of(this).stackName}/worker-join-command`;
    const sshKeyName = `${cdk.Stack.of(this).stackName.toLowerCase()}-ssh-key`;

    const vpc = ec2.Vpc.fromLookup(this, 'DockerVpc', { vpcId: params.vpcId });

    const routeTable = new ec2.CfnRouteTable(this, 'DockerRouteTable', {
      vpcId: vpc.vpcId,
      tags: [
        {
          key: 'Name',
          value: `${cdk.Stack.of(this).stackName}-docker-route-table`,
        },
      ],
    });

    new ec2.CfnSubnetRouteTableAssociation(this, 'DockerSubnetRouteTableAssociation', {
      subnetId: params.subnetId,
      routeTableId: routeTable.ref,
    });

    const subnet = ec2.Subnet.fromSubnetAttributes(this, 'DockerSubnet', {
      subnetId: params.subnetId,
      availabilityZone: params.availabilityZone,
      routeTableId: routeTable.ref,
    });
    const vpcSubnets = { subnets: [subnet] };

    // Manager security group
    const managerSg = new ec2.SecurityGroup(this, 'DockerManagerSg', {
      vpc,
      securityGroupName: 'docker-manager-sg',
      description: 'Docker Swarm manager security group',
      allowAllOutbound: true,
      disableInlineRules: true,
    });

    // Worker security group
    const workerSg = new ec2.SecurityGroup(this, 'DockerWorkerSg', {
      vpc,
      securityGroupName: 'docker-worker-sg',
      description: 'Docker Swarm worker security group',
      allowAllOutbound: true,
      disableInlineRules: true,
    });

    // --- Manager ingress rules ---
    managerSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH');
    // Workers join the swarm via manager on 2377
    managerSg.addIngressRule(ec2.Peer.securityGroupId(workerSg.securityGroupId), ec2.Port.tcp(2377), 'Swarm join from workers');
    // Managers join and communicate with other managers
    managerSg.addIngressRule(ec2.Peer.securityGroupId(managerSg.securityGroupId), ec2.Port.tcp(2377), 'Swarm manager join and control plane');
    managerSg.addIngressRule(ec2.Peer.securityGroupId(managerSg.securityGroupId), ec2.Port.tcp(7946), 'Node comm TCP between managers');
    managerSg.addIngressRule(ec2.Peer.securityGroupId(managerSg.securityGroupId), ec2.Port.udp(7946), 'Node comm UDP between managers');
    managerSg.addIngressRule(ec2.Peer.securityGroupId(managerSg.securityGroupId), ec2.Port.udp(4789), 'Overlay network between managers');
    // Node-to-node communication from workers
    managerSg.addIngressRule(ec2.Peer.securityGroupId(workerSg.securityGroupId), ec2.Port.tcp(7946), 'Node comm TCP from workers');
    managerSg.addIngressRule(ec2.Peer.securityGroupId(workerSg.securityGroupId), ec2.Port.udp(7946), 'Node comm UDP from workers');
    // Overlay network from workers
    managerSg.addIngressRule(ec2.Peer.securityGroupId(workerSg.securityGroupId), ec2.Port.udp(4789), 'Overlay network from workers');

    // --- Worker ingress rules ---
    workerSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH');
    // Node-to-node communication from manager
    workerSg.addIngressRule(ec2.Peer.securityGroupId(managerSg.securityGroupId), ec2.Port.tcp(7946), 'Node comm TCP from manager');
    workerSg.addIngressRule(ec2.Peer.securityGroupId(managerSg.securityGroupId), ec2.Port.udp(7946), 'Node comm UDP from manager');
    // Overlay network from manager
    workerSg.addIngressRule(ec2.Peer.securityGroupId(managerSg.securityGroupId), ec2.Port.udp(4789), 'Overlay network from manager');
    // Worker-to-worker communication for overlay networking
    workerSg.addIngressRule(ec2.Peer.securityGroupId(workerSg.securityGroupId), ec2.Port.tcp(7946), 'Node comm TCP between workers');
    workerSg.addIngressRule(ec2.Peer.securityGroupId(workerSg.securityGroupId), ec2.Port.udp(7946), 'Node comm UDP between workers');
    workerSg.addIngressRule(ec2.Peer.securityGroupId(workerSg.securityGroupId), ec2.Port.udp(4789), 'Overlay network between workers');

    const endpointSg = new ec2.SecurityGroup(this, 'DockerVpcEndpointSg', {
      vpc,
      securityGroupName: 'docker-vpc-endpoint-sg',
      description: 'VPC endpoint security group for Docker Swarm private instances',
      allowAllOutbound: true,
      disableInlineRules: true,
    });
    endpointSg.addIngressRule(managerSg, ec2.Port.tcp(443), 'HTTPS from Docker managers');
    endpointSg.addIngressRule(workerSg, ec2.Port.tcp(443), 'HTTPS from Docker workers');

    const enableVpcDnsSupport = new cr.AwsCustomResource(this, 'EnableDockerVpcDnsSupport', {
      onCreate: {
        service: 'EC2',
        action: 'modifyVpcAttribute',
        parameters: {
          VpcId: vpc.vpcId,
          EnableDnsSupport: { Value: true },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${params.vpcId}-dns-support`),
      },
      onUpdate: {
        service: 'EC2',
        action: 'modifyVpcAttribute',
        parameters: {
          VpcId: vpc.vpcId,
          EnableDnsSupport: { Value: true },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${params.vpcId}-dns-support`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    const enableVpcDnsHostnames = new cr.AwsCustomResource(this, 'EnableDockerVpcDnsHostnames', {
      onCreate: {
        service: 'EC2',
        action: 'modifyVpcAttribute',
        parameters: {
          VpcId: vpc.vpcId,
          EnableDnsHostnames: { Value: true },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${params.vpcId}-dns-hostnames`),
      },
      onUpdate: {
        service: 'EC2',
        action: 'modifyVpcAttribute',
        parameters: {
          VpcId: vpc.vpcId,
          EnableDnsHostnames: { Value: true },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${params.vpcId}-dns-hostnames`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    const ssmEndpoint = vpc.addInterfaceEndpoint('DockerSsmEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: vpcSubnets,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });
    cdk.Tags.of(ssmEndpoint).add('Name', `${cdk.Stack.of(this).stackName}-ssm-endpoint`);
    const ec2MessagesEndpoint = vpc.addInterfaceEndpoint('DockerEc2MessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      subnets: vpcSubnets,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });
    cdk.Tags.of(ec2MessagesEndpoint).add('Name', `${cdk.Stack.of(this).stackName}-ec2messages-endpoint`);
    const ssmMessagesEndpoint = vpc.addInterfaceEndpoint('DockerSsmMessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      subnets: vpcSubnets,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });
    cdk.Tags.of(ssmMessagesEndpoint).add('Name', `${cdk.Stack.of(this).stackName}-ssmmessages-endpoint`);
    const ecrApiEndpoint = vpc.addInterfaceEndpoint('DockerEcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets: vpcSubnets,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });
    cdk.Tags.of(ecrApiEndpoint).add('Name', `${cdk.Stack.of(this).stackName}-ecr-api-endpoint`);
    const ecrDockerEndpoint = vpc.addInterfaceEndpoint('DockerEcrDockerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: vpcSubnets,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });
    cdk.Tags.of(ecrDockerEndpoint).add('Name', `${cdk.Stack.of(this).stackName}-ecr-docker-endpoint`);
    const s3Endpoint = vpc.addGatewayEndpoint('DockerS3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [vpcSubnets],
    });
    cdk.Tags.of(s3Endpoint).add('Name', `${cdk.Stack.of(this).stackName}-s3-gateway-endpoint`);
    [ssmEndpoint, ec2MessagesEndpoint, ssmMessagesEndpoint, ecrApiEndpoint, ecrDockerEndpoint].forEach((endpoint) => {
      endpoint.node.addDependency(enableVpcDnsSupport);
      endpoint.node.addDependency(enableVpcDnsHostnames);
    });

    const instanceRole = new iam.Role(this, 'DockerInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [
        cdk.Stack.of(this).formatArn({
          service: 'ssm',
          resource: 'parameter',
          resourceName: `docker-swarm/${cdk.Stack.of(this).stackName}/*`,
        }),
      ],
    }));
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
      ],
      resources: [
        cdk.Stack.of(this).formatArn({
          service: 'ecr',
          resource: 'repository',
          resourceName: '*',
        }),
      ],
    }));
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['autoscaling:SetInstanceHealth'],
      resources: ['*'],
    }));

    const ami = ec2.MachineImage.genericLinux({
      [cdk.Stack.of(this).region]: params.amiId,
    });
    const instanceType = new ec2.InstanceType(params.instanceType);
    const sshKeyPair = new ec2.KeyPair(this, 'DockerSshKeyPair', {
      keyPairName: sshKeyName,
      format: ec2.KeyPairFormat.PEM,
      type: ec2.KeyPairType.RSA,
    });
    const internalApiRepository = new ecr.Repository(this, 'DockerInternalApiRepository', {
      repositoryName: 'internal-file-api',
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          description: 'Expire untagged images after 7 days',
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(7),
        },
      ],
    });

    const addDockerHealthCheck = (userData: ec2.UserData) => {
      userData.addCommands(
        'cat > /usr/local/bin/docker-asg-healthcheck.sh <<\'EOF\'',
        '#!/bin/bash',
        'set -u',
        'FAIL_DIR=/var/lib/docker-asg-healthcheck',
        'FAIL_FILE="$FAIL_DIR/failures"',
        'mkdir -p "$FAIL_DIR"',
        'if systemctl is-active --quiet docker && timeout 10 docker info >/dev/null 2>&1; then',
        '  echo 0 > "$FAIL_FILE"',
        '  exit 0',
        'fi',
        'FAILURES=0',
        'if [ -f "$FAIL_FILE" ]; then',
        '  FAILURES=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)',
        'fi',
        'FAILURES=$((FAILURES + 1))',
        'echo "$FAILURES" > "$FAIL_FILE"',
        'if [ "$FAILURES" -lt 3 ]; then',
        '  exit 0',
        'fi',
        'TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
        'INSTANCE_ID=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)',
        'aws autoscaling set-instance-health --region "$AWS_REGION" --instance-id "$INSTANCE_ID" --health-status Unhealthy --should-respect-grace-period',
        'EOF',
        'chmod +x /usr/local/bin/docker-asg-healthcheck.sh',
        'cat > /etc/systemd/system/docker-asg-healthcheck.service <<EOF',
        '[Unit]',
        'Description=Report unhealthy Docker instances to Auto Scaling',
        '',
        '[Service]',
        'Type=oneshot',
        `Environment=AWS_REGION=${cdk.Stack.of(this).region}`,
        'ExecStart=/usr/local/bin/docker-asg-healthcheck.sh',
        'EOF',
        'cat > /etc/systemd/system/docker-asg-healthcheck.timer <<\'EOF\'',
        '[Unit]',
        'Description=Run Docker ASG health check',
        '',
        '[Timer]',
        'OnBootSec=5min',
        'OnUnitActiveSec=1min',
        'Unit=docker-asg-healthcheck.service',
        '',
        '[Install]',
        'WantedBy=timers.target',
        'EOF',
        'systemctl daemon-reload',
        'systemctl enable --now docker-asg-healthcheck.timer',
      );
    };

    const addManagerSsmRefresh = (userData: ec2.UserData) => {
      userData.addCommands(
        'cat > /usr/local/bin/docker-manager-ssm-refresh.sh <<\'EOF\'',
        '#!/bin/bash',
        'set -euo pipefail',
        'docker info --format "{{.Swarm.LocalNodeState}}" | grep -q "^active$"',
        'docker info --format "{{.Swarm.ControlAvailable}}" | grep -q "^true$"',
        'TOKEN=$(curl -fsS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
        'PRIVATE_IP=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)',
        'MANAGER_TOKEN=$(docker swarm join-token manager -q)',
        'WORKER_TOKEN=$(docker swarm join-token worker -q)',
        `aws ssm put-parameter --region "$AWS_REGION" --name "${bootstrapManagerIpParameterName}" --type String --overwrite --value "$PRIVATE_IP"`,
        `aws ssm put-parameter --region "$AWS_REGION" --name "${managerJoinCommandParameterName}" --type SecureString --overwrite --value "docker swarm join --token $MANAGER_TOKEN $PRIVATE_IP:2377"`,
        `aws ssm put-parameter --region "$AWS_REGION" --name "${workerJoinCommandParameterName}" --type SecureString --overwrite --value "docker swarm join --token $WORKER_TOKEN $PRIVATE_IP:2377"`,
        'EOF',
        'chmod +x /usr/local/bin/docker-manager-ssm-refresh.sh',
        'cat > /etc/systemd/system/docker-manager-ssm-refresh.service <<EOF',
        '[Unit]',
        'Description=Publish Docker Swarm manager join parameters to SSM',
        '',
        '[Service]',
        'Type=oneshot',
        `Environment=AWS_REGION=${cdk.Stack.of(this).region}`,
        'ExecStart=/usr/local/bin/docker-manager-ssm-refresh.sh',
        'EOF',
        'cat > /etc/systemd/system/docker-manager-ssm-refresh.timer <<\'EOF\'',
        '[Unit]',
        'Description=Run Docker Swarm manager SSM refresh',
        '',
        '[Timer]',
        'OnBootSec=1min',
        'OnUnitActiveSec=1min',
        'Unit=docker-manager-ssm-refresh.service',
        '',
        '[Install]',
        'WantedBy=timers.target',
        'EOF',
        'systemctl daemon-reload',
        'systemctl enable --now docker-manager-ssm-refresh.timer',
        '/usr/local/bin/docker-manager-ssm-refresh.sh || true',
      );
    };

    const managerUserData = ec2.UserData.forLinux();
    managerUserData.addCommands(
      'set -euxo pipefail',
      'TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
      'PRIVATE_IP=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)',
      'publish_swarm_params() {',
      '  MANAGER_TOKEN=$(docker swarm join-token manager -q)',
      '  WORKER_TOKEN=$(docker swarm join-token worker -q)',
      `  aws ssm put-parameter --region ${cdk.Stack.of(this).region} --name "${bootstrapManagerIpParameterName}" --type String --overwrite --value "$PRIVATE_IP"`,
      `  aws ssm put-parameter --region ${cdk.Stack.of(this).region} --name "${managerJoinCommandParameterName}" --type SecureString --overwrite --value "docker swarm join --token $MANAGER_TOKEN $PRIVATE_IP:2377"`,
      `  aws ssm put-parameter --region ${cdk.Stack.of(this).region} --name "${workerJoinCommandParameterName}" --type SecureString --overwrite --value "docker swarm join --token $WORKER_TOKEN $PRIVATE_IP:2377"`,
      '}',
      'init_swarm() {',
      '  docker info --format "{{.Swarm.LocalNodeState}}" | grep -q "^active$" || docker swarm init --advertise-addr "$PRIVATE_IP"',
      '  publish_swarm_params',
      '}',
      `if aws ssm put-parameter --region ${cdk.Stack.of(this).region} --name "${bootstrapManagerIpParameterName}" --type String --value "$PRIVATE_IP" --no-overwrite; then`,
      '  init_swarm',
      'else',
      `  for i in $(seq 1 60); do MANAGER_JOIN_COMMAND=$(aws ssm get-parameter --region ${cdk.Stack.of(this).region} --name "${managerJoinCommandParameterName}" --with-decryption --query Parameter.Value --output text 2>/dev/null) && break; sleep 10; done`,
      '  if [ -n "${MANAGER_JOIN_COMMAND:-}" ]; then',
      '    docker info --format "{{.Swarm.LocalNodeState}}" | grep -q "^active$" || $MANAGER_JOIN_COMMAND || init_swarm',
      '  else',
      '    init_swarm',
      '  fi',
      'fi',
      'docker info --format "{{.Swarm.LocalNodeState}}" | grep -q "^active$" && publish_swarm_params',
    );
    addManagerSsmRefresh(managerUserData);
    addDockerHealthCheck(managerUserData);

    const dockerManagerAsg = new autoscaling.AutoScalingGroup(this, 'DockerManagerAsg', {
      vpc,
      vpcSubnets,
      instanceType,
      machineImage: ami,
      securityGroup: managerSg,
      role: instanceRole,
      keyPair: sshKeyPair,
      userData: managerUserData,
      minCapacity: 3,
      maxCapacity: 4,
      healthChecks: autoscaling.HealthChecks.ec2({
        gracePeriod: cdk.Duration.minutes(5),
      }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 2,
        waitOnResourceSignals: false,
      }),
    });
    dockerManagerAsg.node.addDependency(sshKeyPair);
    dockerManagerAsg.scaleOnCpuUtilization('DockerManagerCpuScaling', {
      targetUtilizationPercent: 60,
      cooldown: cdk.Duration.minutes(5),
    });
    cdk.Tags.of(dockerManagerAsg).add('Name', 'docker-swarm-manager');

    const workerUserData = ec2.UserData.forLinux();
    workerUserData.addCommands(
      'set -euxo pipefail',
      `for i in $(seq 1 60); do JOIN_COMMAND=$(aws ssm get-parameter --region ${cdk.Stack.of(this).region} --name "${workerJoinCommandParameterName}" --with-decryption --query Parameter.Value --output text 2>/dev/null) && break; sleep 10; done`,
      'test -n "${JOIN_COMMAND:-}"',
      'docker info --format "{{.Swarm.LocalNodeState}}" | grep -q "^active$" || $JOIN_COMMAND',
    );
    addDockerHealthCheck(workerUserData);

    const dockerWorkerAsg = new autoscaling.AutoScalingGroup(this, 'DockerWorkerAsg', {
      vpc,
      vpcSubnets,
      instanceType,
      machineImage: ami,
      securityGroup: workerSg,
      role: instanceRole,
      keyPair: sshKeyPair,
      userData: workerUserData,
      minCapacity: 2,
      maxCapacity: 4,
      healthChecks: autoscaling.HealthChecks.ec2({
        gracePeriod: cdk.Duration.minutes(5),
      }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 1,
        waitOnResourceSignals: false,
      }),
    });
    dockerWorkerAsg.node.addDependency(sshKeyPair);
    dockerWorkerAsg.node.addDependency(dockerManagerAsg);
    dockerWorkerAsg.scaleOnCpuUtilization('DockerWorkerCpuScaling', {
      targetUtilizationPercent: 60,
      cooldown: cdk.Duration.minutes(5),
    });
    cdk.Tags.of(dockerWorkerAsg).add('Name', 'docker-swarm-worker');

    new cdk.CfnOutput(this, 'DockerManagerAsgName', {
      value: dockerManagerAsg.autoScalingGroupName,
      description: 'Docker Swarm manager Auto Scaling Group name',
    });

    new cdk.CfnOutput(this, 'DockerWorkerAsgName', {
      value: dockerWorkerAsg.autoScalingGroupName,
      description: 'Docker Swarm worker Auto Scaling Group name',
    });

    new cdk.CfnOutput(this, 'DockerSshKeyPairName', {
      value: sshKeyPair.keyPairName,
      description: 'SSH key pair name for Docker Swarm EC2 instances',
    });

    new cdk.CfnOutput(this, 'DockerWorkerJoinCommandParameterName', {
      value: workerJoinCommandParameterName,
      description: 'SSM SecureString parameter containing the Docker Swarm worker join command',
    });

    new cdk.CfnOutput(this, 'DockerManagerJoinCommandParameterName', {
      value: managerJoinCommandParameterName,
      description: 'SSM SecureString parameter containing the Docker Swarm manager join command',
    });

    new cdk.CfnOutput(this, 'DockerInternalApiRepositoryUri', {
      value: internalApiRepository.repositoryUri,
      description: 'ECR repository URI for the internal file API image',
    });
  }
}
