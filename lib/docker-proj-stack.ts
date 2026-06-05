import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

interface DockerParams {
  vpcId: string;
  subnetId: string;
}

const params: DockerParams = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../parameters.json'), 'utf-8')
);

export class DockerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'DockerVpc', { vpcId: params.vpcId });

    const subnet = ec2.Subnet.fromSubnetId(this, 'DockerSubnet', params.subnetId);

    // Manager security group
    const managerSg = new ec2.SecurityGroup(this, 'DockerManagerSg', {
      vpc,
      securityGroupName: 'docker-manager-sg',
      description: 'Docker Swarm manager security group',
      allowAllOutbound: true,
    });

    // Worker security group
    const workerSg = new ec2.SecurityGroup(this, 'DockerWorkerSg', {
      vpc,
      securityGroupName: 'docker-worker-sg',
      description: 'Docker Swarm worker security group',
      allowAllOutbound: true,
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

    const ami = ec2.MachineImage.fromSsmParameter(
      '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id'
    );
    const instanceType = ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.LARGE);
    const vpcSubnets = { subnets: [subnet] };

    const dockerManager = new ec2.Instance(this, 'DockerManager', {
      instanceName: 'docker-swarm-manager',
      vpc,
      vpcSubnets,
      instanceType,
      machineImage: ami,
      securityGroup: managerSg,
      associatePublicIpAddress: true,
    });

    const dockerWorker = new ec2.Instance(this, 'DockerWorker', {
      instanceName: 'docker-swarm-worker',
      vpc,
      vpcSubnets,
      instanceType,
      machineImage: ami,
      securityGroup: workerSg,
      associatePublicIpAddress: true,
    });

    new cdk.CfnOutput(this, 'DockerManagerIp', {
      value: dockerManager.instancePublicIp,
      description: 'Docker Swarm Manager public IP',
    });

    new cdk.CfnOutput(this, 'DockerWorkerIp', {
      value: dockerWorker.instancePublicIp,
      description: 'Docker Swarm Worker public IP',
    });
  }
}
