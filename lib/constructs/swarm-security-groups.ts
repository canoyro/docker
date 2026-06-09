import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface SwarmSecurityGroupsProps {
  vpc: ec2.IVpc;
}

export class SwarmSecurityGroups extends Construct {
  readonly managerSg: ec2.SecurityGroup;
  readonly workerSg: ec2.SecurityGroup;
  readonly endpointSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SwarmSecurityGroupsProps) {
    super(scope, id);

    const { vpc } = props;

    this.managerSg = new ec2.SecurityGroup(this, 'DockerManagerSg', {
      vpc,
      securityGroupName: 'docker-manager-sg',
      description: 'Docker Swarm manager security group',
      allowAllOutbound: true,
      disableInlineRules: true,
    });

    this.workerSg = new ec2.SecurityGroup(this, 'DockerWorkerSg', {
      vpc,
      securityGroupName: 'docker-worker-sg',
      description: 'Docker Swarm worker security group',
      allowAllOutbound: true,
      disableInlineRules: true,
    });

    this.endpointSg = new ec2.SecurityGroup(this, 'DockerVpcEndpointSg', {
      vpc,
      securityGroupName: 'docker-vpc-endpoint-sg',
      description: 'VPC endpoint security group for Docker Swarm private instances',
      allowAllOutbound: true,
      disableInlineRules: true,
    });

    const swarmPorts: [ec2.Port, string][] = [
      [ec2.Port.tcp(7946), 'Node comm TCP'],
      [ec2.Port.udp(7946), 'Node comm UDP'],
      [ec2.Port.udp(4789), 'Overlay network'],
    ];

    this.managerSg.addIngressRule(ec2.Peer.securityGroupId(this.workerSg.securityGroupId), ec2.Port.tcp(2377), 'Swarm join from workers');
    this.managerSg.addIngressRule(ec2.Peer.securityGroupId(this.managerSg.securityGroupId), ec2.Port.tcp(2377), 'Swarm manager join and control plane');
    for (const [port, label] of swarmPorts) {
      this.managerSg.addIngressRule(ec2.Peer.securityGroupId(this.managerSg.securityGroupId), port, `${label} between managers`);
      this.managerSg.addIngressRule(ec2.Peer.securityGroupId(this.workerSg.securityGroupId), port, `${label} from workers`);
    }

    for (const [port, label] of swarmPorts) {
      this.workerSg.addIngressRule(ec2.Peer.securityGroupId(this.managerSg.securityGroupId), port, `${label} from manager`);
      this.workerSg.addIngressRule(ec2.Peer.securityGroupId(this.workerSg.securityGroupId), port, `${label} between workers`);
    }

    this.endpointSg.addIngressRule(this.managerSg, ec2.Port.tcp(443), 'HTTPS from Docker managers');
    this.endpointSg.addIngressRule(this.workerSg, ec2.Port.tcp(443), 'HTTPS from Docker workers');
  }
}
