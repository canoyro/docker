import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

interface DockerParams {
  vpcId: string;
  subnetId: string;
  availabilityZone: string;
  amiId: string;
}

const params: DockerParams = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../parameters.json'), 'utf-8')
);

export class DockerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
          resourceName: workerJoinCommandParameterName.replace(/^\//, ''),
        }),
      ],
    }));

    const ami = ec2.MachineImage.genericLinux({
      [cdk.Stack.of(this).region]: params.amiId,
    });
    const instanceType = ec2.InstanceType.of(ec2.InstanceClass.C7I_FLEX, ec2.InstanceSize.LARGE);
    const sshKeyPair = new ec2.KeyPair(this, 'DockerSshKeyPair', {
      keyPairName: sshKeyName,
      format: ec2.KeyPairFormat.PEM,
      type: ec2.KeyPairType.RSA,
    });

    const dockerManager = new ec2.Instance(this, 'DockerManager', {
      instanceName: 'docker-swarm-manager',
      vpc,
      vpcSubnets,
      instanceType,
      machineImage: ami,
      securityGroup: managerSg,
      role: instanceRole,
      keyPair: sshKeyPair,
    });
    dockerManager.node.addDependency(sshKeyPair);
    dockerManager.userData.addCommands(
      'set -euxo pipefail',
      'TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
      'PRIVATE_IP=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)',
      'docker info --format "{{.Swarm.LocalNodeState}}" | grep -q "^active$" || docker swarm init --advertise-addr "$PRIVATE_IP"',
      'JOIN_TOKEN=$(docker swarm join-token worker -q)',
      `aws ssm put-parameter --region ${cdk.Stack.of(this).region} --name "${workerJoinCommandParameterName}" --type SecureString --overwrite --value "docker swarm join --token $JOIN_TOKEN $PRIVATE_IP:2377"`,
    );

    const dockerWorker = new ec2.Instance(this, 'DockerWorker', {
      instanceName: 'docker-swarm-worker',
      vpc,
      vpcSubnets,
      instanceType,
      machineImage: ami,
      securityGroup: workerSg,
      role: instanceRole,
      keyPair: sshKeyPair,
    });
    dockerWorker.node.addDependency(sshKeyPair);
    dockerWorker.userData.addCommands(
      'set -euxo pipefail',
      `for i in $(seq 1 60); do JOIN_COMMAND=$(aws ssm get-parameter --region ${cdk.Stack.of(this).region} --name "${workerJoinCommandParameterName}" --with-decryption --query Parameter.Value --output text 2>/dev/null) && break; sleep 10; done`,
      'test -n "${JOIN_COMMAND:-}"',
      'docker info --format "{{.Swarm.LocalNodeState}}" | grep -q "^active$" || $JOIN_COMMAND',
    );
    dockerWorker.node.addDependency(dockerManager);

    new cdk.CfnOutput(this, 'DockerManagerPrivateIp', {
      value: dockerManager.instancePrivateIp,
      description: 'Docker Swarm Manager private IP',
    });

    new cdk.CfnOutput(this, 'DockerWorkerPrivateIp', {
      value: dockerWorker.instancePrivateIp,
      description: 'Docker Swarm Worker private IP',
    });

    new cdk.CfnOutput(this, 'DockerSshKeyPairName', {
      value: sshKeyPair.keyPairName,
      description: 'SSH key pair name for Docker Swarm EC2 instances',
    });

    new cdk.CfnOutput(this, 'DockerWorkerJoinCommandParameterName', {
      value: workerJoinCommandParameterName,
      description: 'SSM SecureString parameter containing the Docker Swarm worker join command',
    });
  }
}
