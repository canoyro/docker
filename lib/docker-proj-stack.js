"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DockerStack = void 0;
const cdk = __importStar(require("aws-cdk-lib/core"));
const autoscaling = __importStar(require("aws-cdk-lib/aws-autoscaling"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const params = JSON.parse(fs.readFileSync(path.join(__dirname, '../parameters.json'), 'utf-8'));
class DockerStack extends cdk.Stack {
    constructor(scope, id, props) {
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
        [ssmEndpoint, ec2MessagesEndpoint, ssmMessagesEndpoint].forEach((endpoint) => {
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
        const ami = ec2.MachineImage.genericLinux({
            [cdk.Stack.of(this).region]: params.amiId,
        });
        const instanceType = new ec2.InstanceType(params.instanceType);
        const sshKeyPair = new ec2.KeyPair(this, 'DockerSshKeyPair', {
            keyPairName: sshKeyName,
            format: ec2.KeyPairFormat.PEM,
            type: ec2.KeyPairType.RSA,
        });
        const managerUserData = ec2.UserData.forLinux();
        managerUserData.addCommands('set -euxo pipefail', 'TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")', 'PRIVATE_IP=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)', `if aws ssm put-parameter --region ${cdk.Stack.of(this).region} --name "${bootstrapManagerIpParameterName}" --type String --value "$PRIVATE_IP" --no-overwrite; then`, '  docker info --format "{{.Swarm.LocalNodeState}}" | grep -q "^active$" || docker swarm init --advertise-addr "$PRIVATE_IP"', '  MANAGER_TOKEN=$(docker swarm join-token manager -q)', '  WORKER_TOKEN=$(docker swarm join-token worker -q)', `  aws ssm put-parameter --region ${cdk.Stack.of(this).region} --name "${managerJoinCommandParameterName}" --type SecureString --overwrite --value "docker swarm join --token $MANAGER_TOKEN $PRIVATE_IP:2377"`, `  aws ssm put-parameter --region ${cdk.Stack.of(this).region} --name "${workerJoinCommandParameterName}" --type SecureString --overwrite --value "docker swarm join --token $WORKER_TOKEN $PRIVATE_IP:2377"`, 'else', `  for i in $(seq 1 60); do MANAGER_JOIN_COMMAND=$(aws ssm get-parameter --region ${cdk.Stack.of(this).region} --name "${managerJoinCommandParameterName}" --with-decryption --query Parameter.Value --output text 2>/dev/null) && break; sleep 10; done`, '  test -n "${MANAGER_JOIN_COMMAND:-}"', '  docker info --format "{{.Swarm.LocalNodeState}}" | grep -q "^active$" || $MANAGER_JOIN_COMMAND', 'fi');
        const dockerManagerAsg = new autoscaling.AutoScalingGroup(this, 'DockerManagerAsg', {
            vpc,
            vpcSubnets,
            instanceType,
            machineImage: ami,
            securityGroup: managerSg,
            role: instanceRole,
            keyPair: sshKeyPair,
            userData: managerUserData,
            minCapacity: 2,
            maxCapacity: 2,
            desiredCapacity: 1,
        });
        dockerManagerAsg.node.addDependency(sshKeyPair);
        cdk.Tags.of(dockerManagerAsg).add('Name', 'docker-swarm-manager');
        const workerUserData = ec2.UserData.forLinux();
        workerUserData.addCommands('set -euxo pipefail', `for i in $(seq 1 60); do JOIN_COMMAND=$(aws ssm get-parameter --region ${cdk.Stack.of(this).region} --name "${workerJoinCommandParameterName}" --with-decryption --query Parameter.Value --output text 2>/dev/null) && break; sleep 10; done`, 'test -n "${JOIN_COMMAND:-}"', 'docker info --format "{{.Swarm.LocalNodeState}}" | grep -q "^active$" || $JOIN_COMMAND');
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
            maxCapacity: 2,
            desiredCapacity: 2,
        });
        dockerWorkerAsg.node.addDependency(sshKeyPair);
        dockerWorkerAsg.node.addDependency(dockerManagerAsg);
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
    }
}
exports.DockerStack = DockerStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZG9ja2VyLXByb2otc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJkb2NrZXItcHJvai1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxzREFBd0M7QUFDeEMseUVBQTJEO0FBQzNELGlFQUFtRDtBQUNuRCx5REFBMkM7QUFDM0MseURBQTJDO0FBRTNDLHVDQUF5QjtBQUN6QiwyQ0FBNkI7QUFVN0IsTUFBTSxNQUFNLEdBQWlCLElBQUksQ0FBQyxLQUFLLENBQ3JDLEVBQUUsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsb0JBQW9CLENBQUMsRUFBRSxPQUFPLENBQUMsQ0FDckUsQ0FBQztBQUVGLE1BQWEsV0FBWSxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQ3hDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDOUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSwrQkFBK0IsR0FBRyxpQkFBaUIsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsU0FBUyx1QkFBdUIsQ0FBQztRQUM3RyxNQUFNLCtCQUErQixHQUFHLGlCQUFpQixHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxTQUFTLHVCQUF1QixDQUFDO1FBQzdHLE1BQU0sOEJBQThCLEdBQUcsaUJBQWlCLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLFNBQVMsc0JBQXNCLENBQUM7UUFDM0csTUFBTSxVQUFVLEdBQUcsR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxTQUFTLENBQUMsV0FBVyxFQUFFLFVBQVUsQ0FBQztRQUUzRSxNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFLEVBQUUsS0FBSyxFQUFFLE1BQU0sQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO1FBRTNFLE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDakUsS0FBSyxFQUFFLEdBQUcsQ0FBQyxLQUFLO1lBQ2hCLElBQUksRUFBRTtnQkFDSjtvQkFDRSxHQUFHLEVBQUUsTUFBTTtvQkFDWCxLQUFLLEVBQUUsR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxTQUFTLHFCQUFxQjtpQkFDNUQ7YUFDRjtTQUNGLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLDhCQUE4QixDQUFDLElBQUksRUFBRSxtQ0FBbUMsRUFBRTtZQUNoRixRQUFRLEVBQUUsTUFBTSxDQUFDLFFBQVE7WUFDekIsWUFBWSxFQUFFLFVBQVUsQ0FBQyxHQUFHO1NBQzdCLENBQUMsQ0FBQztRQUVILE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxNQUFNLENBQUMsb0JBQW9CLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUNuRSxRQUFRLEVBQUUsTUFBTSxDQUFDLFFBQVE7WUFDekIsZ0JBQWdCLEVBQUUsTUFBTSxDQUFDLGdCQUFnQjtZQUN6QyxZQUFZLEVBQUUsVUFBVSxDQUFDLEdBQUc7U0FDN0IsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxVQUFVLEdBQUcsRUFBRSxPQUFPLEVBQUUsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBRXpDLHlCQUF5QjtRQUN6QixNQUFNLFNBQVMsR0FBRyxJQUFJLEdBQUcsQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQy9ELEdBQUc7WUFDSCxpQkFBaUIsRUFBRSxtQkFBbUI7WUFDdEMsV0FBVyxFQUFFLHFDQUFxQztZQUNsRCxnQkFBZ0IsRUFBRSxJQUFJO1lBQ3RCLGtCQUFrQixFQUFFLElBQUk7U0FDekIsQ0FBQyxDQUFDO1FBRUgsd0JBQXdCO1FBQ3hCLE1BQU0sUUFBUSxHQUFHLElBQUksR0FBRyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDN0QsR0FBRztZQUNILGlCQUFpQixFQUFFLGtCQUFrQjtZQUNyQyxXQUFXLEVBQUUsb0NBQW9DO1lBQ2pELGdCQUFnQixFQUFFLElBQUk7WUFDdEIsa0JBQWtCLEVBQUUsSUFBSTtTQUN6QixDQUFDLENBQUM7UUFFSCxnQ0FBZ0M7UUFDaEMsU0FBUyxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3RFLDZDQUE2QztRQUM3QyxTQUFTLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSx5QkFBeUIsQ0FBQyxDQUFDO1FBQzVILG9EQUFvRDtRQUNwRCxTQUFTLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxzQ0FBc0MsQ0FBQyxDQUFDO1FBQzFJLFNBQVMsQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsU0FBUyxDQUFDLGVBQWUsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLGdDQUFnQyxDQUFDLENBQUM7UUFDcEksU0FBUyxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxTQUFTLENBQUMsZUFBZSxDQUFDLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsZ0NBQWdDLENBQUMsQ0FBQztRQUNwSSxTQUFTLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxrQ0FBa0MsQ0FBQyxDQUFDO1FBQ3RJLDBDQUEwQztRQUMxQyxTQUFTLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSw0QkFBNEIsQ0FBQyxDQUFDO1FBQy9ILFNBQVMsQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLDRCQUE0QixDQUFDLENBQUM7UUFDL0gsK0JBQStCO1FBQy9CLFNBQVMsQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLDhCQUE4QixDQUFDLENBQUM7UUFFakksK0JBQStCO1FBQy9CLFFBQVEsQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUNyRSwwQ0FBMEM7UUFDMUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxTQUFTLENBQUMsZUFBZSxDQUFDLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsNEJBQTRCLENBQUMsQ0FBQztRQUMvSCxRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSw0QkFBNEIsQ0FBQyxDQUFDO1FBQy9ILCtCQUErQjtRQUMvQixRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSw4QkFBOEIsQ0FBQyxDQUFDO1FBQ2pJLHdEQUF3RDtRQUN4RCxRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSwrQkFBK0IsQ0FBQyxDQUFDO1FBQ2pJLFFBQVEsQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLCtCQUErQixDQUFDLENBQUM7UUFDakksUUFBUSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxRQUFRLENBQUMsZUFBZSxDQUFDLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsaUNBQWlDLENBQUMsQ0FBQztRQUVuSSxNQUFNLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQ3BFLEdBQUc7WUFDSCxpQkFBaUIsRUFBRSx3QkFBd0I7WUFDM0MsV0FBVyxFQUFFLGdFQUFnRTtZQUM3RSxnQkFBZ0IsRUFBRSxJQUFJO1lBQ3RCLGtCQUFrQixFQUFFLElBQUk7U0FDekIsQ0FBQyxDQUFDO1FBQ0gsVUFBVSxDQUFDLGNBQWMsQ0FBQyxTQUFTLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsNEJBQTRCLENBQUMsQ0FBQztRQUN0RixVQUFVLENBQUMsY0FBYyxDQUFDLFFBQVEsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSwyQkFBMkIsQ0FBQyxDQUFDO1FBRXBGLE1BQU0sbUJBQW1CLEdBQUcsSUFBSSxFQUFFLENBQUMsaUJBQWlCLENBQUMsSUFBSSxFQUFFLDJCQUEyQixFQUFFO1lBQ3RGLFFBQVEsRUFBRTtnQkFDUixPQUFPLEVBQUUsS0FBSztnQkFDZCxNQUFNLEVBQUUsb0JBQW9CO2dCQUM1QixVQUFVLEVBQUU7b0JBQ1YsS0FBSyxFQUFFLEdBQUcsQ0FBQyxLQUFLO29CQUNoQixnQkFBZ0IsRUFBRSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUU7aUJBQ2xDO2dCQUNELGtCQUFrQixFQUFFLEVBQUUsQ0FBQyxrQkFBa0IsQ0FBQyxFQUFFLENBQUMsR0FBRyxNQUFNLENBQUMsS0FBSyxjQUFjLENBQUM7YUFDNUU7WUFDRCxRQUFRLEVBQUU7Z0JBQ1IsT0FBTyxFQUFFLEtBQUs7Z0JBQ2QsTUFBTSxFQUFFLG9CQUFvQjtnQkFDNUIsVUFBVSxFQUFFO29CQUNWLEtBQUssRUFBRSxHQUFHLENBQUMsS0FBSztvQkFDaEIsZ0JBQWdCLEVBQUUsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFO2lCQUNsQztnQkFDRCxrQkFBa0IsRUFBRSxFQUFFLENBQUMsa0JBQWtCLENBQUMsRUFBRSxDQUFDLEdBQUcsTUFBTSxDQUFDLEtBQUssY0FBYyxDQUFDO2FBQzVFO1lBQ0QsTUFBTSxFQUFFLEVBQUUsQ0FBQyx1QkFBdUIsQ0FBQyxZQUFZLENBQUM7Z0JBQzlDLFNBQVMsRUFBRSxFQUFFLENBQUMsdUJBQXVCLENBQUMsWUFBWTthQUNuRCxDQUFDO1NBQ0gsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxxQkFBcUIsR0FBRyxJQUFJLEVBQUUsQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLEVBQUUsNkJBQTZCLEVBQUU7WUFDMUYsUUFBUSxFQUFFO2dCQUNSLE9BQU8sRUFBRSxLQUFLO2dCQUNkLE1BQU0sRUFBRSxvQkFBb0I7Z0JBQzVCLFVBQVUsRUFBRTtvQkFDVixLQUFLLEVBQUUsR0FBRyxDQUFDLEtBQUs7b0JBQ2hCLGtCQUFrQixFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRTtpQkFDcEM7Z0JBQ0Qsa0JBQWtCLEVBQUUsRUFBRSxDQUFDLGtCQUFrQixDQUFDLEVBQUUsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxLQUFLLGdCQUFnQixDQUFDO2FBQzlFO1lBQ0QsUUFBUSxFQUFFO2dCQUNSLE9BQU8sRUFBRSxLQUFLO2dCQUNkLE1BQU0sRUFBRSxvQkFBb0I7Z0JBQzVCLFVBQVUsRUFBRTtvQkFDVixLQUFLLEVBQUUsR0FBRyxDQUFDLEtBQUs7b0JBQ2hCLGtCQUFrQixFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRTtpQkFDcEM7Z0JBQ0Qsa0JBQWtCLEVBQUUsRUFBRSxDQUFDLGtCQUFrQixDQUFDLEVBQUUsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxLQUFLLGdCQUFnQixDQUFDO2FBQzlFO1lBQ0QsTUFBTSxFQUFFLEVBQUUsQ0FBQyx1QkFBdUIsQ0FBQyxZQUFZLENBQUM7Z0JBQzlDLFNBQVMsRUFBRSxFQUFFLENBQUMsdUJBQXVCLENBQUMsWUFBWTthQUNuRCxDQUFDO1NBQ0gsQ0FBQyxDQUFDO1FBRUgsTUFBTSxXQUFXLEdBQUcsR0FBRyxDQUFDLG9CQUFvQixDQUFDLG1CQUFtQixFQUFFO1lBQ2hFLE9BQU8sRUFBRSxHQUFHLENBQUMsOEJBQThCLENBQUMsR0FBRztZQUMvQyxPQUFPLEVBQUUsVUFBVTtZQUNuQixjQUFjLEVBQUUsQ0FBQyxVQUFVLENBQUM7WUFDNUIsaUJBQWlCLEVBQUUsSUFBSTtTQUN4QixDQUFDLENBQUM7UUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxXQUFXLENBQUMsQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLEdBQUcsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsU0FBUyxlQUFlLENBQUMsQ0FBQztRQUNyRixNQUFNLG1CQUFtQixHQUFHLEdBQUcsQ0FBQyxvQkFBb0IsQ0FBQywyQkFBMkIsRUFBRTtZQUNoRixPQUFPLEVBQUUsR0FBRyxDQUFDLDhCQUE4QixDQUFDLFlBQVk7WUFDeEQsT0FBTyxFQUFFLFVBQVU7WUFDbkIsY0FBYyxFQUFFLENBQUMsVUFBVSxDQUFDO1lBQzVCLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBQ0gsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsbUJBQW1CLENBQUMsQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLEdBQUcsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsU0FBUyx1QkFBdUIsQ0FBQyxDQUFDO1FBQ3JHLE1BQU0sbUJBQW1CLEdBQUcsR0FBRyxDQUFDLG9CQUFvQixDQUFDLDJCQUEyQixFQUFFO1lBQ2hGLE9BQU8sRUFBRSxHQUFHLENBQUMsOEJBQThCLENBQUMsWUFBWTtZQUN4RCxPQUFPLEVBQUUsVUFBVTtZQUNuQixjQUFjLEVBQUUsQ0FBQyxVQUFVLENBQUM7WUFDNUIsaUJBQWlCLEVBQUUsSUFBSTtTQUN4QixDQUFDLENBQUM7UUFDSCxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxTQUFTLHVCQUF1QixDQUFDLENBQUM7UUFDckcsQ0FBQyxXQUFXLEVBQUUsbUJBQW1CLEVBQUUsbUJBQW1CLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxRQUFRLEVBQUUsRUFBRTtZQUMzRSxRQUFRLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDO1lBQ2pELFFBQVEsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLHFCQUFxQixDQUFDLENBQUM7UUFDckQsQ0FBQyxDQUFDLENBQUM7UUFFSCxNQUFNLFlBQVksR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO1lBQzVELFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxtQkFBbUIsQ0FBQztZQUN4RCxlQUFlLEVBQUU7Z0JBQ2YsR0FBRyxDQUFDLGFBQWEsQ0FBQyx3QkFBd0IsQ0FBQyw4QkFBOEIsQ0FBQzthQUMzRTtTQUNGLENBQUMsQ0FBQztRQUNILFlBQVksQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQy9DLE9BQU8sRUFBRSxDQUFDLGtCQUFrQixFQUFFLGtCQUFrQixDQUFDO1lBQ2pELFNBQVMsRUFBRTtnQkFDVCxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxTQUFTLENBQUM7b0JBQzNCLE9BQU8sRUFBRSxLQUFLO29CQUNkLFFBQVEsRUFBRSxXQUFXO29CQUNyQixZQUFZLEVBQUUsZ0JBQWdCLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLFNBQVMsSUFBSTtpQkFDL0QsQ0FBQzthQUNIO1NBQ0YsQ0FBQyxDQUFDLENBQUM7UUFFSixNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMsWUFBWSxDQUFDLFlBQVksQ0FBQztZQUN4QyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFFLE1BQU0sQ0FBQyxLQUFLO1NBQzFDLENBQUMsQ0FBQztRQUNILE1BQU0sWUFBWSxHQUFHLElBQUksR0FBRyxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLENBQUM7UUFDL0QsTUFBTSxVQUFVLEdBQUcsSUFBSSxHQUFHLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUMzRCxXQUFXLEVBQUUsVUFBVTtZQUN2QixNQUFNLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxHQUFHO1lBQzdCLElBQUksRUFBRSxHQUFHLENBQUMsV0FBVyxDQUFDLEdBQUc7U0FDMUIsQ0FBQyxDQUFDO1FBRUgsTUFBTSxlQUFlLEdBQUcsR0FBRyxDQUFDLFFBQVEsQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUNoRCxlQUFlLENBQUMsV0FBVyxDQUN6QixvQkFBb0IsRUFDcEIsaUhBQWlILEVBQ2pILDZHQUE2RyxFQUM3RyxxQ0FBcUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxZQUFZLCtCQUErQiw0REFBNEQsRUFDckssNkhBQTZILEVBQzdILHVEQUF1RCxFQUN2RCxxREFBcUQsRUFDckQsb0NBQW9DLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sWUFBWSwrQkFBK0IsdUdBQXVHLEVBQy9NLG9DQUFvQyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxNQUFNLFlBQVksOEJBQThCLHNHQUFzRyxFQUM3TSxNQUFNLEVBQ04sb0ZBQW9GLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sWUFBWSwrQkFBK0IsaUdBQWlHLEVBQ3pQLHVDQUF1QyxFQUN2QyxrR0FBa0csRUFDbEcsSUFBSSxDQUNMLENBQUM7UUFFRixNQUFNLGdCQUFnQixHQUFHLElBQUksV0FBVyxDQUFDLGdCQUFnQixDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUNsRixHQUFHO1lBQ0gsVUFBVTtZQUNWLFlBQVk7WUFDWixZQUFZLEVBQUUsR0FBRztZQUNqQixhQUFhLEVBQUUsU0FBUztZQUN4QixJQUFJLEVBQUUsWUFBWTtZQUNsQixPQUFPLEVBQUUsVUFBVTtZQUNuQixRQUFRLEVBQUUsZUFBZTtZQUN6QixXQUFXLEVBQUUsQ0FBQztZQUNkLFdBQVcsRUFBRSxDQUFDO1lBQ2QsZUFBZSxFQUFFLENBQUM7U0FDbkIsQ0FBQyxDQUFDO1FBQ0gsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUNoRCxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsc0JBQXNCLENBQUMsQ0FBQztRQUVsRSxNQUFNLGNBQWMsR0FBRyxHQUFHLENBQUMsUUFBUSxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQy9DLGNBQWMsQ0FBQyxXQUFXLENBQ3hCLG9CQUFvQixFQUNwQiwwRUFBMEUsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxZQUFZLDhCQUE4QixpR0FBaUcsRUFDOU8sNkJBQTZCLEVBQzdCLHdGQUF3RixDQUN6RixDQUFDO1FBRUYsTUFBTSxlQUFlLEdBQUcsSUFBSSxXQUFXLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQ2hGLEdBQUc7WUFDSCxVQUFVO1lBQ1YsWUFBWTtZQUNaLFlBQVksRUFBRSxHQUFHO1lBQ2pCLGFBQWEsRUFBRSxRQUFRO1lBQ3ZCLElBQUksRUFBRSxZQUFZO1lBQ2xCLE9BQU8sRUFBRSxVQUFVO1lBQ25CLFFBQVEsRUFBRSxjQUFjO1lBQ3hCLFdBQVcsRUFBRSxDQUFDO1lBQ2QsV0FBVyxFQUFFLENBQUM7WUFDZCxlQUFlLEVBQUUsQ0FBQztTQUNuQixDQUFDLENBQUM7UUFDSCxlQUFlLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUMvQyxlQUFlLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1FBQ3JELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLGVBQWUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUscUJBQXFCLENBQUMsQ0FBQztRQUVoRSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHNCQUFzQixFQUFFO1lBQzlDLEtBQUssRUFBRSxnQkFBZ0IsQ0FBQyxvQkFBb0I7WUFDNUMsV0FBVyxFQUFFLDhDQUE4QztTQUM1RCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQzdDLEtBQUssRUFBRSxlQUFlLENBQUMsb0JBQW9CO1lBQzNDLFdBQVcsRUFBRSw2Q0FBNkM7U0FDM0QsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxzQkFBc0IsRUFBRTtZQUM5QyxLQUFLLEVBQUUsVUFBVSxDQUFDLFdBQVc7WUFDN0IsV0FBVyxFQUFFLGtEQUFrRDtTQUNoRSxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHNDQUFzQyxFQUFFO1lBQzlELEtBQUssRUFBRSw4QkFBOEI7WUFDckMsV0FBVyxFQUFFLDRFQUE0RTtTQUMxRixDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHVDQUF1QyxFQUFFO1lBQy9ELEtBQUssRUFBRSwrQkFBK0I7WUFDdEMsV0FBVyxFQUFFLDZFQUE2RTtTQUMzRixDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFoUkQsa0NBZ1JDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliL2NvcmUnO1xuaW1wb3J0ICogYXMgYXV0b3NjYWxpbmcgZnJvbSAnYXdzLWNkay1saWIvYXdzLWF1dG9zY2FsaW5nJztcbmltcG9ydCAqIGFzIGNyIGZyb20gJ2F3cy1jZGstbGliL2N1c3RvbS1yZXNvdXJjZXMnO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5pbnRlcmZhY2UgRG9ja2VyUGFyYW1zIHtcbiAgdnBjSWQ6IHN0cmluZztcbiAgc3VibmV0SWQ6IHN0cmluZztcbiAgYXZhaWxhYmlsaXR5Wm9uZTogc3RyaW5nO1xuICBhbWlJZDogc3RyaW5nO1xuICBpbnN0YW5jZVR5cGU6IHN0cmluZztcbn1cblxuY29uc3QgcGFyYW1zOiBEb2NrZXJQYXJhbXMgPSBKU09OLnBhcnNlKFxuICBmcy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL3BhcmFtZXRlcnMuanNvbicpLCAndXRmLTgnKVxuKTtcblxuZXhwb3J0IGNsYXNzIERvY2tlclN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgYm9vdHN0cmFwTWFuYWdlcklwUGFyYW1ldGVyTmFtZSA9IGAvZG9ja2VyLXN3YXJtLyR7Y2RrLlN0YWNrLm9mKHRoaXMpLnN0YWNrTmFtZX0vYm9vdHN0cmFwLW1hbmFnZXItaXBgO1xuICAgIGNvbnN0IG1hbmFnZXJKb2luQ29tbWFuZFBhcmFtZXRlck5hbWUgPSBgL2RvY2tlci1zd2FybS8ke2Nkay5TdGFjay5vZih0aGlzKS5zdGFja05hbWV9L21hbmFnZXItam9pbi1jb21tYW5kYDtcbiAgICBjb25zdCB3b3JrZXJKb2luQ29tbWFuZFBhcmFtZXRlck5hbWUgPSBgL2RvY2tlci1zd2FybS8ke2Nkay5TdGFjay5vZih0aGlzKS5zdGFja05hbWV9L3dvcmtlci1qb2luLWNvbW1hbmRgO1xuICAgIGNvbnN0IHNzaEtleU5hbWUgPSBgJHtjZGsuU3RhY2sub2YodGhpcykuc3RhY2tOYW1lLnRvTG93ZXJDYXNlKCl9LXNzaC1rZXlgO1xuXG4gICAgY29uc3QgdnBjID0gZWMyLlZwYy5mcm9tTG9va3VwKHRoaXMsICdEb2NrZXJWcGMnLCB7IHZwY0lkOiBwYXJhbXMudnBjSWQgfSk7XG5cbiAgICBjb25zdCByb3V0ZVRhYmxlID0gbmV3IGVjMi5DZm5Sb3V0ZVRhYmxlKHRoaXMsICdEb2NrZXJSb3V0ZVRhYmxlJywge1xuICAgICAgdnBjSWQ6IHZwYy52cGNJZCxcbiAgICAgIHRhZ3M6IFtcbiAgICAgICAge1xuICAgICAgICAgIGtleTogJ05hbWUnLFxuICAgICAgICAgIHZhbHVlOiBgJHtjZGsuU3RhY2sub2YodGhpcykuc3RhY2tOYW1lfS1kb2NrZXItcm91dGUtdGFibGVgLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIG5ldyBlYzIuQ2ZuU3VibmV0Um91dGVUYWJsZUFzc29jaWF0aW9uKHRoaXMsICdEb2NrZXJTdWJuZXRSb3V0ZVRhYmxlQXNzb2NpYXRpb24nLCB7XG4gICAgICBzdWJuZXRJZDogcGFyYW1zLnN1Ym5ldElkLFxuICAgICAgcm91dGVUYWJsZUlkOiByb3V0ZVRhYmxlLnJlZixcbiAgICB9KTtcblxuICAgIGNvbnN0IHN1Ym5ldCA9IGVjMi5TdWJuZXQuZnJvbVN1Ym5ldEF0dHJpYnV0ZXModGhpcywgJ0RvY2tlclN1Ym5ldCcsIHtcbiAgICAgIHN1Ym5ldElkOiBwYXJhbXMuc3VibmV0SWQsXG4gICAgICBhdmFpbGFiaWxpdHlab25lOiBwYXJhbXMuYXZhaWxhYmlsaXR5Wm9uZSxcbiAgICAgIHJvdXRlVGFibGVJZDogcm91dGVUYWJsZS5yZWYsXG4gICAgfSk7XG4gICAgY29uc3QgdnBjU3VibmV0cyA9IHsgc3VibmV0czogW3N1Ym5ldF0gfTtcblxuICAgIC8vIE1hbmFnZXIgc2VjdXJpdHkgZ3JvdXBcbiAgICBjb25zdCBtYW5hZ2VyU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0RvY2tlck1hbmFnZXJTZycsIHtcbiAgICAgIHZwYyxcbiAgICAgIHNlY3VyaXR5R3JvdXBOYW1lOiAnZG9ja2VyLW1hbmFnZXItc2cnLFxuICAgICAgZGVzY3JpcHRpb246ICdEb2NrZXIgU3dhcm0gbWFuYWdlciBzZWN1cml0eSBncm91cCcsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgICAgZGlzYWJsZUlubGluZVJ1bGVzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gV29ya2VyIHNlY3VyaXR5IGdyb3VwXG4gICAgY29uc3Qgd29ya2VyU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0RvY2tlcldvcmtlclNnJywge1xuICAgICAgdnBjLFxuICAgICAgc2VjdXJpdHlHcm91cE5hbWU6ICdkb2NrZXItd29ya2VyLXNnJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRG9ja2VyIFN3YXJtIHdvcmtlciBzZWN1cml0eSBncm91cCcsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgICAgZGlzYWJsZUlubGluZVJ1bGVzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gLS0tIE1hbmFnZXIgaW5ncmVzcyBydWxlcyAtLS1cbiAgICBtYW5hZ2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuYW55SXB2NCgpLCBlYzIuUG9ydC50Y3AoMjIpLCAnU1NIJyk7XG4gICAgLy8gV29ya2VycyBqb2luIHRoZSBzd2FybSB2aWEgbWFuYWdlciBvbiAyMzc3XG4gICAgbWFuYWdlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZCh3b3JrZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC50Y3AoMjM3NyksICdTd2FybSBqb2luIGZyb20gd29ya2VycycpO1xuICAgIC8vIE1hbmFnZXJzIGpvaW4gYW5kIGNvbW11bmljYXRlIHdpdGggb3RoZXIgbWFuYWdlcnNcbiAgICBtYW5hZ2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKG1hbmFnZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC50Y3AoMjM3NyksICdTd2FybSBtYW5hZ2VyIGpvaW4gYW5kIGNvbnRyb2wgcGxhbmUnKTtcbiAgICBtYW5hZ2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKG1hbmFnZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC50Y3AoNzk0NiksICdOb2RlIGNvbW0gVENQIGJldHdlZW4gbWFuYWdlcnMnKTtcbiAgICBtYW5hZ2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKG1hbmFnZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC51ZHAoNzk0NiksICdOb2RlIGNvbW0gVURQIGJldHdlZW4gbWFuYWdlcnMnKTtcbiAgICBtYW5hZ2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKG1hbmFnZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC51ZHAoNDc4OSksICdPdmVybGF5IG5ldHdvcmsgYmV0d2VlbiBtYW5hZ2VycycpO1xuICAgIC8vIE5vZGUtdG8tbm9kZSBjb21tdW5pY2F0aW9uIGZyb20gd29ya2Vyc1xuICAgIG1hbmFnZXJTZy5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5zZWN1cml0eUdyb3VwSWQod29ya2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudGNwKDc5NDYpLCAnTm9kZSBjb21tIFRDUCBmcm9tIHdvcmtlcnMnKTtcbiAgICBtYW5hZ2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKHdvcmtlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnVkcCg3OTQ2KSwgJ05vZGUgY29tbSBVRFAgZnJvbSB3b3JrZXJzJyk7XG4gICAgLy8gT3ZlcmxheSBuZXR3b3JrIGZyb20gd29ya2Vyc1xuICAgIG1hbmFnZXJTZy5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5zZWN1cml0eUdyb3VwSWQod29ya2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudWRwKDQ3ODkpLCAnT3ZlcmxheSBuZXR3b3JrIGZyb20gd29ya2VycycpO1xuXG4gICAgLy8gLS0tIFdvcmtlciBpbmdyZXNzIHJ1bGVzIC0tLVxuICAgIHdvcmtlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLmFueUlwdjQoKSwgZWMyLlBvcnQudGNwKDIyKSwgJ1NTSCcpO1xuICAgIC8vIE5vZGUtdG8tbm9kZSBjb21tdW5pY2F0aW9uIGZyb20gbWFuYWdlclxuICAgIHdvcmtlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZChtYW5hZ2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudGNwKDc5NDYpLCAnTm9kZSBjb21tIFRDUCBmcm9tIG1hbmFnZXInKTtcbiAgICB3b3JrZXJTZy5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5zZWN1cml0eUdyb3VwSWQobWFuYWdlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnVkcCg3OTQ2KSwgJ05vZGUgY29tbSBVRFAgZnJvbSBtYW5hZ2VyJyk7XG4gICAgLy8gT3ZlcmxheSBuZXR3b3JrIGZyb20gbWFuYWdlclxuICAgIHdvcmtlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZChtYW5hZ2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudWRwKDQ3ODkpLCAnT3ZlcmxheSBuZXR3b3JrIGZyb20gbWFuYWdlcicpO1xuICAgIC8vIFdvcmtlci10by13b3JrZXIgY29tbXVuaWNhdGlvbiBmb3Igb3ZlcmxheSBuZXR3b3JraW5nXG4gICAgd29ya2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKHdvcmtlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnRjcCg3OTQ2KSwgJ05vZGUgY29tbSBUQ1AgYmV0d2VlbiB3b3JrZXJzJyk7XG4gICAgd29ya2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKHdvcmtlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnVkcCg3OTQ2KSwgJ05vZGUgY29tbSBVRFAgYmV0d2VlbiB3b3JrZXJzJyk7XG4gICAgd29ya2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKHdvcmtlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnVkcCg0Nzg5KSwgJ092ZXJsYXkgbmV0d29yayBiZXR3ZWVuIHdvcmtlcnMnKTtcblxuICAgIGNvbnN0IGVuZHBvaW50U2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0RvY2tlclZwY0VuZHBvaW50U2cnLCB7XG4gICAgICB2cGMsXG4gICAgICBzZWN1cml0eUdyb3VwTmFtZTogJ2RvY2tlci12cGMtZW5kcG9pbnQtc2cnLFxuICAgICAgZGVzY3JpcHRpb246ICdWUEMgZW5kcG9pbnQgc2VjdXJpdHkgZ3JvdXAgZm9yIERvY2tlciBTd2FybSBwcml2YXRlIGluc3RhbmNlcycsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgICAgZGlzYWJsZUlubGluZVJ1bGVzOiB0cnVlLFxuICAgIH0pO1xuICAgIGVuZHBvaW50U2cuYWRkSW5ncmVzc1J1bGUobWFuYWdlclNnLCBlYzIuUG9ydC50Y3AoNDQzKSwgJ0hUVFBTIGZyb20gRG9ja2VyIG1hbmFnZXJzJyk7XG4gICAgZW5kcG9pbnRTZy5hZGRJbmdyZXNzUnVsZSh3b3JrZXJTZywgZWMyLlBvcnQudGNwKDQ0MyksICdIVFRQUyBmcm9tIERvY2tlciB3b3JrZXJzJyk7XG5cbiAgICBjb25zdCBlbmFibGVWcGNEbnNTdXBwb3J0ID0gbmV3IGNyLkF3c0N1c3RvbVJlc291cmNlKHRoaXMsICdFbmFibGVEb2NrZXJWcGNEbnNTdXBwb3J0Jywge1xuICAgICAgb25DcmVhdGU6IHtcbiAgICAgICAgc2VydmljZTogJ0VDMicsXG4gICAgICAgIGFjdGlvbjogJ21vZGlmeVZwY0F0dHJpYnV0ZScsXG4gICAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgICBWcGNJZDogdnBjLnZwY0lkLFxuICAgICAgICAgIEVuYWJsZURuc1N1cHBvcnQ6IHsgVmFsdWU6IHRydWUgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoYCR7cGFyYW1zLnZwY0lkfS1kbnMtc3VwcG9ydGApLFxuICAgICAgfSxcbiAgICAgIG9uVXBkYXRlOiB7XG4gICAgICAgIHNlcnZpY2U6ICdFQzInLFxuICAgICAgICBhY3Rpb246ICdtb2RpZnlWcGNBdHRyaWJ1dGUnLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgVnBjSWQ6IHZwYy52cGNJZCxcbiAgICAgICAgICBFbmFibGVEbnNTdXBwb3J0OiB7IFZhbHVlOiB0cnVlIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogY3IuUGh5c2ljYWxSZXNvdXJjZUlkLm9mKGAke3BhcmFtcy52cGNJZH0tZG5zLXN1cHBvcnRgKSxcbiAgICAgIH0sXG4gICAgICBwb2xpY3k6IGNyLkF3c0N1c3RvbVJlc291cmNlUG9saWN5LmZyb21TZGtDYWxscyh7XG4gICAgICAgIHJlc291cmNlczogY3IuQXdzQ3VzdG9tUmVzb3VyY2VQb2xpY3kuQU5ZX1JFU09VUkNFLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgY29uc3QgZW5hYmxlVnBjRG5zSG9zdG5hbWVzID0gbmV3IGNyLkF3c0N1c3RvbVJlc291cmNlKHRoaXMsICdFbmFibGVEb2NrZXJWcGNEbnNIb3N0bmFtZXMnLCB7XG4gICAgICBvbkNyZWF0ZToge1xuICAgICAgICBzZXJ2aWNlOiAnRUMyJyxcbiAgICAgICAgYWN0aW9uOiAnbW9kaWZ5VnBjQXR0cmlidXRlJyxcbiAgICAgICAgcGFyYW1ldGVyczoge1xuICAgICAgICAgIFZwY0lkOiB2cGMudnBjSWQsXG4gICAgICAgICAgRW5hYmxlRG5zSG9zdG5hbWVzOiB7IFZhbHVlOiB0cnVlIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogY3IuUGh5c2ljYWxSZXNvdXJjZUlkLm9mKGAke3BhcmFtcy52cGNJZH0tZG5zLWhvc3RuYW1lc2ApLFxuICAgICAgfSxcbiAgICAgIG9uVXBkYXRlOiB7XG4gICAgICAgIHNlcnZpY2U6ICdFQzInLFxuICAgICAgICBhY3Rpb246ICdtb2RpZnlWcGNBdHRyaWJ1dGUnLFxuICAgICAgICBwYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgVnBjSWQ6IHZwYy52cGNJZCxcbiAgICAgICAgICBFbmFibGVEbnNIb3N0bmFtZXM6IHsgVmFsdWU6IHRydWUgfSxcbiAgICAgICAgfSxcbiAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoYCR7cGFyYW1zLnZwY0lkfS1kbnMtaG9zdG5hbWVzYCksXG4gICAgICB9LFxuICAgICAgcG9saWN5OiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU2RrQ2FsbHMoe1xuICAgICAgICByZXNvdXJjZXM6IGNyLkF3c0N1c3RvbVJlc291cmNlUG9saWN5LkFOWV9SRVNPVVJDRSxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc3NtRW5kcG9pbnQgPSB2cGMuYWRkSW50ZXJmYWNlRW5kcG9pbnQoJ0RvY2tlclNzbUVuZHBvaW50Jywge1xuICAgICAgc2VydmljZTogZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5TU00sXG4gICAgICBzdWJuZXRzOiB2cGNTdWJuZXRzLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtlbmRwb2ludFNnXSxcbiAgICAgIHByaXZhdGVEbnNFbmFibGVkOiB0cnVlLFxuICAgIH0pO1xuICAgIGNkay5UYWdzLm9mKHNzbUVuZHBvaW50KS5hZGQoJ05hbWUnLCBgJHtjZGsuU3RhY2sub2YodGhpcykuc3RhY2tOYW1lfS1zc20tZW5kcG9pbnRgKTtcbiAgICBjb25zdCBlYzJNZXNzYWdlc0VuZHBvaW50ID0gdnBjLmFkZEludGVyZmFjZUVuZHBvaW50KCdEb2NrZXJFYzJNZXNzYWdlc0VuZHBvaW50Jywge1xuICAgICAgc2VydmljZTogZWMyLkludGVyZmFjZVZwY0VuZHBvaW50QXdzU2VydmljZS5FQzJfTUVTU0FHRVMsXG4gICAgICBzdWJuZXRzOiB2cGNTdWJuZXRzLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtlbmRwb2ludFNnXSxcbiAgICAgIHByaXZhdGVEbnNFbmFibGVkOiB0cnVlLFxuICAgIH0pO1xuICAgIGNkay5UYWdzLm9mKGVjMk1lc3NhZ2VzRW5kcG9pbnQpLmFkZCgnTmFtZScsIGAke2Nkay5TdGFjay5vZih0aGlzKS5zdGFja05hbWV9LWVjMm1lc3NhZ2VzLWVuZHBvaW50YCk7XG4gICAgY29uc3Qgc3NtTWVzc2FnZXNFbmRwb2ludCA9IHZwYy5hZGRJbnRlcmZhY2VFbmRwb2ludCgnRG9ja2VyU3NtTWVzc2FnZXNFbmRwb2ludCcsIHtcbiAgICAgIHNlcnZpY2U6IGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UuU1NNX01FU1NBR0VTLFxuICAgICAgc3VibmV0czogdnBjU3VibmV0cyxcbiAgICAgIHNlY3VyaXR5R3JvdXBzOiBbZW5kcG9pbnRTZ10sXG4gICAgICBwcml2YXRlRG5zRW5hYmxlZDogdHJ1ZSxcbiAgICB9KTtcbiAgICBjZGsuVGFncy5vZihzc21NZXNzYWdlc0VuZHBvaW50KS5hZGQoJ05hbWUnLCBgJHtjZGsuU3RhY2sub2YodGhpcykuc3RhY2tOYW1lfS1zc21tZXNzYWdlcy1lbmRwb2ludGApO1xuICAgIFtzc21FbmRwb2ludCwgZWMyTWVzc2FnZXNFbmRwb2ludCwgc3NtTWVzc2FnZXNFbmRwb2ludF0uZm9yRWFjaCgoZW5kcG9pbnQpID0+IHtcbiAgICAgIGVuZHBvaW50Lm5vZGUuYWRkRGVwZW5kZW5jeShlbmFibGVWcGNEbnNTdXBwb3J0KTtcbiAgICAgIGVuZHBvaW50Lm5vZGUuYWRkRGVwZW5kZW5jeShlbmFibGVWcGNEbnNIb3N0bmFtZXMpO1xuICAgIH0pO1xuXG4gICAgY29uc3QgaW5zdGFuY2VSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdEb2NrZXJJbnN0YW5jZVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWMyLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ0FtYXpvblNTTU1hbmFnZWRJbnN0YW5jZUNvcmUnKSxcbiAgICAgIF0sXG4gICAgfSk7XG4gICAgaW5zdGFuY2VSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGFjdGlvbnM6IFsnc3NtOkdldFBhcmFtZXRlcicsICdzc206UHV0UGFyYW1ldGVyJ10sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgY2RrLlN0YWNrLm9mKHRoaXMpLmZvcm1hdEFybih7XG4gICAgICAgICAgc2VydmljZTogJ3NzbScsXG4gICAgICAgICAgcmVzb3VyY2U6ICdwYXJhbWV0ZXInLFxuICAgICAgICAgIHJlc291cmNlTmFtZTogYGRvY2tlci1zd2FybS8ke2Nkay5TdGFjay5vZih0aGlzKS5zdGFja05hbWV9LypgLFxuICAgICAgICB9KSxcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgY29uc3QgYW1pID0gZWMyLk1hY2hpbmVJbWFnZS5nZW5lcmljTGludXgoe1xuICAgICAgW2Nkay5TdGFjay5vZih0aGlzKS5yZWdpb25dOiBwYXJhbXMuYW1pSWQsXG4gICAgfSk7XG4gICAgY29uc3QgaW5zdGFuY2VUeXBlID0gbmV3IGVjMi5JbnN0YW5jZVR5cGUocGFyYW1zLmluc3RhbmNlVHlwZSk7XG4gICAgY29uc3Qgc3NoS2V5UGFpciA9IG5ldyBlYzIuS2V5UGFpcih0aGlzLCAnRG9ja2VyU3NoS2V5UGFpcicsIHtcbiAgICAgIGtleVBhaXJOYW1lOiBzc2hLZXlOYW1lLFxuICAgICAgZm9ybWF0OiBlYzIuS2V5UGFpckZvcm1hdC5QRU0sXG4gICAgICB0eXBlOiBlYzIuS2V5UGFpclR5cGUuUlNBLFxuICAgIH0pO1xuXG4gICAgY29uc3QgbWFuYWdlclVzZXJEYXRhID0gZWMyLlVzZXJEYXRhLmZvckxpbnV4KCk7XG4gICAgbWFuYWdlclVzZXJEYXRhLmFkZENvbW1hbmRzKFxuICAgICAgJ3NldCAtZXV4byBwaXBlZmFpbCcsXG4gICAgICAnVE9LRU49JChjdXJsIC1YIFBVVCBcImh0dHA6Ly8xNjkuMjU0LjE2OS4yNTQvbGF0ZXN0L2FwaS90b2tlblwiIC1IIFwiWC1hd3MtZWMyLW1ldGFkYXRhLXRva2VuLXR0bC1zZWNvbmRzOiAyMTYwMFwiKScsXG4gICAgICAnUFJJVkFURV9JUD0kKGN1cmwgLUggXCJYLWF3cy1lYzItbWV0YWRhdGEtdG9rZW46ICRUT0tFTlwiIGh0dHA6Ly8xNjkuMjU0LjE2OS4yNTQvbGF0ZXN0L21ldGEtZGF0YS9sb2NhbC1pcHY0KScsXG4gICAgICBgaWYgYXdzIHNzbSBwdXQtcGFyYW1ldGVyIC0tcmVnaW9uICR7Y2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbn0gLS1uYW1lIFwiJHtib290c3RyYXBNYW5hZ2VySXBQYXJhbWV0ZXJOYW1lfVwiIC0tdHlwZSBTdHJpbmcgLS12YWx1ZSBcIiRQUklWQVRFX0lQXCIgLS1uby1vdmVyd3JpdGU7IHRoZW5gLFxuICAgICAgJyAgZG9ja2VyIGluZm8gLS1mb3JtYXQgXCJ7ey5Td2FybS5Mb2NhbE5vZGVTdGF0ZX19XCIgfCBncmVwIC1xIFwiXmFjdGl2ZSRcIiB8fCBkb2NrZXIgc3dhcm0gaW5pdCAtLWFkdmVydGlzZS1hZGRyIFwiJFBSSVZBVEVfSVBcIicsXG4gICAgICAnICBNQU5BR0VSX1RPS0VOPSQoZG9ja2VyIHN3YXJtIGpvaW4tdG9rZW4gbWFuYWdlciAtcSknLFxuICAgICAgJyAgV09SS0VSX1RPS0VOPSQoZG9ja2VyIHN3YXJtIGpvaW4tdG9rZW4gd29ya2VyIC1xKScsXG4gICAgICBgICBhd3Mgc3NtIHB1dC1wYXJhbWV0ZXIgLS1yZWdpb24gJHtjZGsuU3RhY2sub2YodGhpcykucmVnaW9ufSAtLW5hbWUgXCIke21hbmFnZXJKb2luQ29tbWFuZFBhcmFtZXRlck5hbWV9XCIgLS10eXBlIFNlY3VyZVN0cmluZyAtLW92ZXJ3cml0ZSAtLXZhbHVlIFwiZG9ja2VyIHN3YXJtIGpvaW4gLS10b2tlbiAkTUFOQUdFUl9UT0tFTiAkUFJJVkFURV9JUDoyMzc3XCJgLFxuICAgICAgYCAgYXdzIHNzbSBwdXQtcGFyYW1ldGVyIC0tcmVnaW9uICR7Y2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbn0gLS1uYW1lIFwiJHt3b3JrZXJKb2luQ29tbWFuZFBhcmFtZXRlck5hbWV9XCIgLS10eXBlIFNlY3VyZVN0cmluZyAtLW92ZXJ3cml0ZSAtLXZhbHVlIFwiZG9ja2VyIHN3YXJtIGpvaW4gLS10b2tlbiAkV09SS0VSX1RPS0VOICRQUklWQVRFX0lQOjIzNzdcImAsXG4gICAgICAnZWxzZScsXG4gICAgICBgICBmb3IgaSBpbiAkKHNlcSAxIDYwKTsgZG8gTUFOQUdFUl9KT0lOX0NPTU1BTkQ9JChhd3Mgc3NtIGdldC1wYXJhbWV0ZXIgLS1yZWdpb24gJHtjZGsuU3RhY2sub2YodGhpcykucmVnaW9ufSAtLW5hbWUgXCIke21hbmFnZXJKb2luQ29tbWFuZFBhcmFtZXRlck5hbWV9XCIgLS13aXRoLWRlY3J5cHRpb24gLS1xdWVyeSBQYXJhbWV0ZXIuVmFsdWUgLS1vdXRwdXQgdGV4dCAyPi9kZXYvbnVsbCkgJiYgYnJlYWs7IHNsZWVwIDEwOyBkb25lYCxcbiAgICAgICcgIHRlc3QgLW4gXCIke01BTkFHRVJfSk9JTl9DT01NQU5EOi19XCInLFxuICAgICAgJyAgZG9ja2VyIGluZm8gLS1mb3JtYXQgXCJ7ey5Td2FybS5Mb2NhbE5vZGVTdGF0ZX19XCIgfCBncmVwIC1xIFwiXmFjdGl2ZSRcIiB8fCAkTUFOQUdFUl9KT0lOX0NPTU1BTkQnLFxuICAgICAgJ2ZpJyxcbiAgICApO1xuXG4gICAgY29uc3QgZG9ja2VyTWFuYWdlckFzZyA9IG5ldyBhdXRvc2NhbGluZy5BdXRvU2NhbGluZ0dyb3VwKHRoaXMsICdEb2NrZXJNYW5hZ2VyQXNnJywge1xuICAgICAgdnBjLFxuICAgICAgdnBjU3VibmV0cyxcbiAgICAgIGluc3RhbmNlVHlwZSxcbiAgICAgIG1hY2hpbmVJbWFnZTogYW1pLFxuICAgICAgc2VjdXJpdHlHcm91cDogbWFuYWdlclNnLFxuICAgICAgcm9sZTogaW5zdGFuY2VSb2xlLFxuICAgICAga2V5UGFpcjogc3NoS2V5UGFpcixcbiAgICAgIHVzZXJEYXRhOiBtYW5hZ2VyVXNlckRhdGEsXG4gICAgICBtaW5DYXBhY2l0eTogMixcbiAgICAgIG1heENhcGFjaXR5OiAyLFxuICAgICAgZGVzaXJlZENhcGFjaXR5OiAxLFxuICAgIH0pO1xuICAgIGRvY2tlck1hbmFnZXJBc2cubm9kZS5hZGREZXBlbmRlbmN5KHNzaEtleVBhaXIpO1xuICAgIGNkay5UYWdzLm9mKGRvY2tlck1hbmFnZXJBc2cpLmFkZCgnTmFtZScsICdkb2NrZXItc3dhcm0tbWFuYWdlcicpO1xuXG4gICAgY29uc3Qgd29ya2VyVXNlckRhdGEgPSBlYzIuVXNlckRhdGEuZm9yTGludXgoKTtcbiAgICB3b3JrZXJVc2VyRGF0YS5hZGRDb21tYW5kcyhcbiAgICAgICdzZXQgLWV1eG8gcGlwZWZhaWwnLFxuICAgICAgYGZvciBpIGluICQoc2VxIDEgNjApOyBkbyBKT0lOX0NPTU1BTkQ9JChhd3Mgc3NtIGdldC1wYXJhbWV0ZXIgLS1yZWdpb24gJHtjZGsuU3RhY2sub2YodGhpcykucmVnaW9ufSAtLW5hbWUgXCIke3dvcmtlckpvaW5Db21tYW5kUGFyYW1ldGVyTmFtZX1cIiAtLXdpdGgtZGVjcnlwdGlvbiAtLXF1ZXJ5IFBhcmFtZXRlci5WYWx1ZSAtLW91dHB1dCB0ZXh0IDI+L2Rldi9udWxsKSAmJiBicmVhazsgc2xlZXAgMTA7IGRvbmVgLFxuICAgICAgJ3Rlc3QgLW4gXCIke0pPSU5fQ09NTUFORDotfVwiJyxcbiAgICAgICdkb2NrZXIgaW5mbyAtLWZvcm1hdCBcInt7LlN3YXJtLkxvY2FsTm9kZVN0YXRlfX1cIiB8IGdyZXAgLXEgXCJeYWN0aXZlJFwiIHx8ICRKT0lOX0NPTU1BTkQnLFxuICAgICk7XG5cbiAgICBjb25zdCBkb2NrZXJXb3JrZXJBc2cgPSBuZXcgYXV0b3NjYWxpbmcuQXV0b1NjYWxpbmdHcm91cCh0aGlzLCAnRG9ja2VyV29ya2VyQXNnJywge1xuICAgICAgdnBjLFxuICAgICAgdnBjU3VibmV0cyxcbiAgICAgIGluc3RhbmNlVHlwZSxcbiAgICAgIG1hY2hpbmVJbWFnZTogYW1pLFxuICAgICAgc2VjdXJpdHlHcm91cDogd29ya2VyU2csXG4gICAgICByb2xlOiBpbnN0YW5jZVJvbGUsXG4gICAgICBrZXlQYWlyOiBzc2hLZXlQYWlyLFxuICAgICAgdXNlckRhdGE6IHdvcmtlclVzZXJEYXRhLFxuICAgICAgbWluQ2FwYWNpdHk6IDIsXG4gICAgICBtYXhDYXBhY2l0eTogMixcbiAgICAgIGRlc2lyZWRDYXBhY2l0eTogMixcbiAgICB9KTtcbiAgICBkb2NrZXJXb3JrZXJBc2cubm9kZS5hZGREZXBlbmRlbmN5KHNzaEtleVBhaXIpO1xuICAgIGRvY2tlcldvcmtlckFzZy5ub2RlLmFkZERlcGVuZGVuY3koZG9ja2VyTWFuYWdlckFzZyk7XG4gICAgY2RrLlRhZ3Mub2YoZG9ja2VyV29ya2VyQXNnKS5hZGQoJ05hbWUnLCAnZG9ja2VyLXN3YXJtLXdvcmtlcicpO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RvY2tlck1hbmFnZXJBc2dOYW1lJywge1xuICAgICAgdmFsdWU6IGRvY2tlck1hbmFnZXJBc2cuYXV0b1NjYWxpbmdHcm91cE5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ0RvY2tlciBTd2FybSBtYW5hZ2VyIEF1dG8gU2NhbGluZyBHcm91cCBuYW1lJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEb2NrZXJXb3JrZXJBc2dOYW1lJywge1xuICAgICAgdmFsdWU6IGRvY2tlcldvcmtlckFzZy5hdXRvU2NhbGluZ0dyb3VwTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRG9ja2VyIFN3YXJtIHdvcmtlciBBdXRvIFNjYWxpbmcgR3JvdXAgbmFtZScsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRG9ja2VyU3NoS2V5UGFpck5hbWUnLCB7XG4gICAgICB2YWx1ZTogc3NoS2V5UGFpci5rZXlQYWlyTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU1NIIGtleSBwYWlyIG5hbWUgZm9yIERvY2tlciBTd2FybSBFQzIgaW5zdGFuY2VzJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEb2NrZXJXb3JrZXJKb2luQ29tbWFuZFBhcmFtZXRlck5hbWUnLCB7XG4gICAgICB2YWx1ZTogd29ya2VySm9pbkNvbW1hbmRQYXJhbWV0ZXJOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdTU00gU2VjdXJlU3RyaW5nIHBhcmFtZXRlciBjb250YWluaW5nIHRoZSBEb2NrZXIgU3dhcm0gd29ya2VyIGpvaW4gY29tbWFuZCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRG9ja2VyTWFuYWdlckpvaW5Db21tYW5kUGFyYW1ldGVyTmFtZScsIHtcbiAgICAgIHZhbHVlOiBtYW5hZ2VySm9pbkNvbW1hbmRQYXJhbWV0ZXJOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdTU00gU2VjdXJlU3RyaW5nIHBhcmFtZXRlciBjb250YWluaW5nIHRoZSBEb2NrZXIgU3dhcm0gbWFuYWdlciBqb2luIGNvbW1hbmQnLFxuICAgIH0pO1xuICB9XG59XG4iXX0=