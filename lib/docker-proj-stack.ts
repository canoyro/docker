import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import { SwarmSecurityGroups } from './constructs/swarm-security-groups.js';
import { SwarmVpcEndpoints } from './constructs/swarm-vpc-endpoints.js';
import { SwarmCompute } from './constructs/swarm-compute.js';

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

    const vpc = ec2.Vpc.fromLookup(this, 'DockerVpc', { vpcId: params.vpcId });

    const routeTable = new ec2.CfnRouteTable(this, 'DockerRouteTable', {
      vpcId: vpc.vpcId,
      tags: [{ key: 'Name', value: `${this.stackName}-docker-route-table` }],
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

    const sgs = new SwarmSecurityGroups(this, 'SwarmSgs', { vpc });

    new SwarmVpcEndpoints(this, 'SwarmEndpoints', {
      vpc,
      vpcSubnets,
      endpointSg: sgs.endpointSg,
    });

    const compute = new SwarmCompute(this, 'SwarmCompute', {
      vpc,
      vpcSubnets,
      managerSg: sgs.managerSg,
      workerSg: sgs.workerSg,
      instanceType: params.instanceType,
      amiId: params.amiId,
    });

    new cdk.CfnOutput(this, 'DockerManagerAsgName', {
      value: compute.managerAsgName,
      description: 'Docker Swarm manager Auto Scaling Group name',
    });
    new cdk.CfnOutput(this, 'DockerWorkerAsgName', {
      value: compute.workerAsgName,
      description: 'Docker Swarm worker Auto Scaling Group name',
    });
    new cdk.CfnOutput(this, 'DockerSshKeyPairName', {
      value: compute.sshKeyPairName,
      description: 'SSH key pair name for Docker Swarm EC2 instances',
    });
    new cdk.CfnOutput(this, 'DockerWorkerJoinCommandParameterName', {
      value: `/docker-swarm/${this.stackName}/worker-join-command`,
      description: 'SSM SecureString parameter containing the Docker Swarm worker join command',
    });
    new cdk.CfnOutput(this, 'DockerManagerJoinCommandParameterName', {
      value: `/docker-swarm/${this.stackName}/manager-join-command`,
      description: 'SSM SecureString parameter containing the Docker Swarm manager join command',
    });
    new cdk.CfnOutput(this, 'DockerInternalApiRepositoryUri', {
      value: compute.internalApiRepositoryUri,
      description: 'ECR repository URI for the internal file API image',
    });
    new cdk.CfnOutput(this, 'SharedStorageBucketName', {
      value: compute.sharedStorageBucketName,
      description: 'S3 bucket name for shared storage via S3 Mountpoint',
    });
  }
}
