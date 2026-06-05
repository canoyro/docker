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

    const dockerSg = new ec2.SecurityGroup(this, 'DockerSwarmSg', {
      vpc,
      securityGroupName: 'docker-swarm-sg',
      description: 'Docker Swarm security group',
      allowAllOutbound: true,
    });

    // SSH
    dockerSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH');
    // Swarm cluster management (manager only)
    dockerSg.addIngressRule(ec2.Peer.securityGroupId(dockerSg.securityGroupId), ec2.Port.tcp(2377), 'Swarm management');
    // Node-to-node communication
    dockerSg.addIngressRule(ec2.Peer.securityGroupId(dockerSg.securityGroupId), ec2.Port.tcp(7946), 'Node comm TCP');
    dockerSg.addIngressRule(ec2.Peer.securityGroupId(dockerSg.securityGroupId), ec2.Port.udp(7946), 'Node comm UDP');
    // Overlay network
    dockerSg.addIngressRule(ec2.Peer.securityGroupId(dockerSg.securityGroupId), ec2.Port.udp(4789), 'Overlay network');

    const ami = ec2.MachineImage.latestAmazonLinux2023();
    const instanceType = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO);
    const vpcSubnets = { subnets: [subnet] };

    const dockerManager = new ec2.Instance(this, 'DockerManager', {
      instanceName: 'docker-swarm-manager',
      vpc,
      vpcSubnets,
      instanceType,
      machineImage: ami,
      securityGroup: dockerSg,
      associatePublicIpAddress: true,
    });

    const dockerWorker = new ec2.Instance(this, 'DockerWorker', {
      instanceName: 'docker-swarm-worker',
      vpc,
      vpcSubnets,
      instanceType,
      machineImage: ami,
      securityGroup: dockerSg,
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
