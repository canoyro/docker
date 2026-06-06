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
            maxCapacity: 4,
            desiredCapacity: 2,
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
            maxCapacity: 4,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZG9ja2VyLXByb2otc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJkb2NrZXItcHJvai1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxzREFBd0M7QUFDeEMseUVBQTJEO0FBQzNELGlFQUFtRDtBQUNuRCx5REFBMkM7QUFDM0MseURBQTJDO0FBRTNDLHVDQUF5QjtBQUN6QiwyQ0FBNkI7QUFVN0IsTUFBTSxNQUFNLEdBQWlCLElBQUksQ0FBQyxLQUFLLENBQ3JDLEVBQUUsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsb0JBQW9CLENBQUMsRUFBRSxPQUFPLENBQUMsQ0FDckUsQ0FBQztBQUVGLE1BQWEsV0FBWSxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQ3hDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDOUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSwrQkFBK0IsR0FBRyxpQkFBaUIsR0FBRyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsU0FBUyx1QkFBdUIsQ0FBQztRQUM3RyxNQUFNLCtCQUErQixHQUFHLGlCQUFpQixHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxTQUFTLHVCQUF1QixDQUFDO1FBQzdHLE1BQU0sOEJBQThCLEdBQUcsaUJBQWlCLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLFNBQVMsc0JBQXNCLENBQUM7UUFDM0csTUFBTSxVQUFVLEdBQUcsR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxTQUFTLENBQUMsV0FBVyxFQUFFLFVBQVUsQ0FBQztRQUUzRSxNQUFNLEdBQUcsR0FBRyxHQUFH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cUJBQXFCLENBQUMsQ0FBQztRQUVoRSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHNCQUFzQixFQUFFO1lBQzlDLEtBQUssRUFBRSxnQkFBZ0IsQ0FBQyxvQkFBb0I7WUFDNUMsV0FBVyxFQUFFLDhDQUE4QztTQUM1RCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQzdDLEtBQUssRUFBRSxlQUFlLENBQUMsb0JBQW9CO1lBQzNDLFdBQVcsRUFBRSw2Q0FBNkM7U0FDM0QsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxzQkFBc0IsRUFBRTtZQUM5QyxLQUFLLEVBQUUsVUFBVSxDQUFDLFdBQVc7WUFDN0IsV0FBVyxFQUFFLGtEQUFrRDtTQUNoRSxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHNDQUFzQyxFQUFFO1lBQzlELEtBQUssRUFBRSw4QkFBOEI7WUFDckMsV0FBVyxFQUFFLDRFQUE0RTtTQUMxRixDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHVDQUF1QyxFQUFFO1lBQy9ELEtBQUssRUFBRSwrQkFBK0I7WUFDdEMsV0FBVyxFQUFFLDZFQUE2RTtTQUMzRixDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFoUkQsa0NBZ1JDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliL2NvcmUnO1xyXG5pbXBvcnQgKiBhcyBhdXRvc2NhbGluZyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtYXV0b3NjYWxpbmcnO1xyXG5pbXBvcnQgKiBhcyBjciBmcm9tICdhd3MtY2RrLWxpYi9jdXN0b20tcmVzb3VyY2VzJztcclxuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xyXG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XHJcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xyXG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XHJcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XHJcblxyXG5pbnRlcmZhY2UgRG9ja2VyUGFyYW1zIHtcclxuICB2cGNJZDogc3RyaW5nO1xyXG4gIHN1Ym5ldElkOiBzdHJpbmc7XHJcbiAgYXZhaWxhYmlsaXR5Wm9uZTogc3RyaW5nO1xyXG4gIGFtaUlkOiBzdHJpbmc7XHJcbiAgaW5zdGFuY2VUeXBlOiBzdHJpbmc7XHJcbn1cclxuXHJcbmNvbnN0IHBhcmFtczogRG9ja2VyUGFyYW1zID0gSlNPTi5wYXJzZShcclxuICBmcy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL3BhcmFtZXRlcnMuanNvbicpLCAndXRmLTgnKVxyXG4pO1xyXG5cclxuZXhwb3J0IGNsYXNzIERvY2tlclN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcclxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XHJcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcclxuXHJcbiAgICBjb25zdCBib290c3RyYXBNYW5hZ2VySXBQYXJhbWV0ZXJOYW1lID0gYC9kb2NrZXItc3dhcm0vJHtjZGsuU3RhY2sub2YodGhpcykuc3RhY2tOYW1lfS9ib290c3RyYXAtbWFuYWdlci1pcGA7XHJcbiAgICBjb25zdCBtYW5hZ2VySm9pbkNvbW1hbmRQYXJhbWV0ZXJOYW1lID0gYC9kb2NrZXItc3dhcm0vJHtjZGsuU3RhY2sub2YodGhpcykuc3RhY2tOYW1lfS9tYW5hZ2VyLWpvaW4tY29tbWFuZGA7XHJcbiAgICBjb25zdCB3b3JrZXJKb2luQ29tbWFuZFBhcmFtZXRlck5hbWUgPSBgL2RvY2tlci1zd2FybS8ke2Nkay5TdGFjay5vZih0aGlzKS5zdGFja05hbWV9L3dvcmtlci1qb2luLWNvbW1hbmRgO1xyXG4gICAgY29uc3Qgc3NoS2V5TmFtZSA9IGAke2Nkay5TdGFjay5vZih0aGlzKS5zdGFja05hbWUudG9Mb3dlckNhc2UoKX0tc3NoLWtleWA7XHJcblxyXG4gICAgY29uc3QgdnBjID0gZWMyLlZwYy5mcm9tTG9va3VwKHRoaXMsICdEb2NrZXJWcGMnLCB7IHZwY0lkOiBwYXJhbXMudnBjSWQgfSk7XHJcblxyXG4gICAgY29uc3Qgcm91dGVUYWJsZSA9IG5ldyBlYzIuQ2ZuUm91dGVUYWJsZSh0aGlzLCAnRG9ja2VyUm91dGVUYWJsZScsIHtcclxuICAgICAgdnBjSWQ6IHZwYy52cGNJZCxcclxuICAgICAgdGFnczogW1xyXG4gICAgICAgIHtcclxuICAgICAgICAgIGtleTogJ05hbWUnLFxyXG4gICAgICAgICAgdmFsdWU6IGAke2Nkay5TdGFjay5vZih0aGlzKS5zdGFja05hbWV9LWRvY2tlci1yb3V0ZS10YWJsZWAsXHJcbiAgICAgICAgfSxcclxuICAgICAgXSxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBlYzIuQ2ZuU3VibmV0Um91dGVUYWJsZUFzc29jaWF0aW9uKHRoaXMsICdEb2NrZXJTdWJuZXRSb3V0ZVRhYmxlQXNzb2NpYXRpb24nLCB7XHJcbiAgICAgIHN1Ym5ldElkOiBwYXJhbXMuc3VibmV0SWQsXHJcbiAgICAgIHJvdXRlVGFibGVJZDogcm91dGVUYWJsZS5yZWYsXHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBzdWJuZXQgPSBlYzIuU3VibmV0LmZyb21TdWJuZXRBdHRyaWJ1dGVzKHRoaXMsICdEb2NrZXJTdWJuZXQnLCB7XHJcbiAgICAgIHN1Ym5ldElkOiBwYXJhbXMuc3VibmV0SWQsXHJcbiAgICAgIGF2YWlsYWJpbGl0eVpvbmU6IHBhcmFtcy5hdmFpbGFiaWxpdHlab25lLFxyXG4gICAgICByb3V0ZVRhYmxlSWQ6IHJvdXRlVGFibGUucmVmLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCB2cGNTdWJuZXRzID0geyBzdWJuZXRzOiBbc3VibmV0XSB9O1xyXG5cclxuICAgIC8vIE1hbmFnZXIgc2VjdXJpdHkgZ3JvdXBcclxuICAgIGNvbnN0IG1hbmFnZXJTZyA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnRG9ja2VyTWFuYWdlclNnJywge1xyXG4gICAgICB2cGMsXHJcbiAgICAgIHNlY3VyaXR5R3JvdXBOYW1lOiAnZG9ja2VyLW1hbmFnZXItc2cnLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ0RvY2tlciBTd2FybSBtYW5hZ2VyIHNlY3VyaXR5IGdyb3VwJyxcclxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcclxuICAgICAgZGlzYWJsZUlubGluZVJ1bGVzOiB0cnVlLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gV29ya2VyIHNlY3VyaXR5IGdyb3VwXHJcbiAgICBjb25zdCB3b3JrZXJTZyA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnRG9ja2VyV29ya2VyU2cnLCB7XHJcbiAgICAgIHZwYyxcclxuICAgICAgc2VjdXJpdHlHcm91cE5hbWU6ICdkb2NrZXItd29ya2VyLXNnJyxcclxuICAgICAgZGVzY3JpcHRpb246ICdEb2NrZXIgU3dhcm0gd29ya2VyIHNlY3VyaXR5IGdyb3VwJyxcclxuICAgICAgYWxsb3dBbGxPdXRib3VuZDogdHJ1ZSxcclxuICAgICAgZGlzYWJsZUlubGluZVJ1bGVzOiB0cnVlLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tIE1hbmFnZXIgaW5ncmVzcyBydWxlcyAtLS1cclxuICAgIG1hbmFnZXJTZy5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5hbnlJcHY0KCksIGVjMi5Qb3J0LnRjcCgyMiksICdTU0gnKTtcclxuICAgIC8vIFdvcmtlcnMgam9pbiB0aGUgc3dhcm0gdmlhIG1hbmFnZXIgb24gMjM3N1xyXG4gICAgbWFuYWdlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZCh3b3JrZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC50Y3AoMjM3NyksICdTd2FybSBqb2luIGZyb20gd29ya2VycycpO1xyXG4gICAgLy8gTWFuYWdlcnMgam9pbiBhbmQgY29tbXVuaWNhdGUgd2l0aCBvdGhlciBtYW5hZ2Vyc1xyXG4gICAgbWFuYWdlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZChtYW5hZ2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudGNwKDIzNzcpLCAnU3dhcm0gbWFuYWdlciBqb2luIGFuZCBjb250cm9sIHBsYW5lJyk7XHJcbiAgICBtYW5hZ2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKG1hbmFnZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC50Y3AoNzk0NiksICdOb2RlIGNvbW0gVENQIGJldHdlZW4gbWFuYWdlcnMnKTtcclxuICAgIG1hbmFnZXJTZy5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5zZWN1cml0eUdyb3VwSWQobWFuYWdlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnVkcCg3OTQ2KSwgJ05vZGUgY29tbSBVRFAgYmV0d2VlbiBtYW5hZ2VycycpO1xyXG4gICAgbWFuYWdlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZChtYW5hZ2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudWRwKDQ3ODkpLCAnT3ZlcmxheSBuZXR3b3JrIGJldHdlZW4gbWFuYWdlcnMnKTtcclxuICAgIC8vIE5vZGUtdG8tbm9kZSBjb21tdW5pY2F0aW9uIGZyb20gd29ya2Vyc1xyXG4gICAgbWFuYWdlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZCh3b3JrZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC50Y3AoNzk0NiksICdOb2RlIGNvbW0gVENQIGZyb20gd29ya2VycycpO1xyXG4gICAgbWFuYWdlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZCh3b3JrZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC51ZHAoNzk0NiksICdOb2RlIGNvbW0gVURQIGZyb20gd29ya2VycycpO1xyXG4gICAgLy8gT3ZlcmxheSBuZXR3b3JrIGZyb20gd29ya2Vyc1xyXG4gICAgbWFuYWdlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZCh3b3JrZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC51ZHAoNDc4OSksICdPdmVybGF5IG5ldHdvcmsgZnJvbSB3b3JrZXJzJyk7XHJcblxyXG4gICAgLy8gLS0tIFdvcmtlciBpbmdyZXNzIHJ1bGVzIC0tLVxyXG4gICAgd29ya2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuYW55SXB2NCgpLCBlYzIuUG9ydC50Y3AoMjIpLCAnU1NIJyk7XHJcbiAgICAvLyBOb2RlLXRvLW5vZGUgY29tbXVuaWNhdGlvbiBmcm9tIG1hbmFnZXJcclxuICAgIHdvcmtlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZChtYW5hZ2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudGNwKDc5NDYpLCAnTm9kZSBjb21tIFRDUCBmcm9tIG1hbmFnZXInKTtcclxuICAgIHdvcmtlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZChtYW5hZ2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudWRwKDc5NDYpLCAnTm9kZSBjb21tIFVEUCBmcm9tIG1hbmFnZXInKTtcclxuICAgIC8vIE92ZXJsYXkgbmV0d29yayBmcm9tIG1hbmFnZXJcclxuICAgIHdvcmtlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZChtYW5hZ2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudWRwKDQ3ODkpLCAnT3ZlcmxheSBuZXR3b3JrIGZyb20gbWFuYWdlcicpO1xyXG4gICAgLy8gV29ya2VyLXRvLXdvcmtlciBjb21tdW5pY2F0aW9uIGZvciBvdmVybGF5IG5ldHdvcmtpbmdcclxuICAgIHdvcmtlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZCh3b3JrZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC50Y3AoNzk0NiksICdOb2RlIGNvbW0gVENQIGJldHdlZW4gd29ya2VycycpO1xyXG4gICAgd29ya2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKHdvcmtlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnVkcCg3OTQ2KSwgJ05vZGUgY29tbSBVRFAgYmV0d2VlbiB3b3JrZXJzJyk7XHJcbiAgICB3b3JrZXJTZy5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5zZWN1cml0eUdyb3VwSWQod29ya2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudWRwKDQ3ODkpLCAnT3ZlcmxheSBuZXR3b3JrIGJldHdlZW4gd29ya2VycycpO1xyXG5cclxuICAgIGNvbnN0IGVuZHBvaW50U2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0RvY2tlclZwY0VuZHBvaW50U2cnLCB7XHJcbiAgICAgIHZwYyxcclxuICAgICAgc2VjdXJpdHlHcm91cE5hbWU6ICdkb2NrZXItdnBjLWVuZHBvaW50LXNnJyxcclxuICAgICAgZGVzY3JpcHRpb246ICdWUEMgZW5kcG9pbnQgc2VjdXJpdHkgZ3JvdXAgZm9yIERvY2tlciBTd2FybSBwcml2YXRlIGluc3RhbmNlcycsXHJcbiAgICAgIGFsbG93QWxsT3V0Ym91bmQ6IHRydWUsXHJcbiAgICAgIGRpc2FibGVJbmxpbmVSdWxlczogdHJ1ZSxcclxuICAgIH0pO1xyXG4gICAgZW5kcG9pbnRTZy5hZGRJbmdyZXNzUnVsZShtYW5hZ2VyU2csIGVjMi5Qb3J0LnRjcCg0NDMpLCAnSFRUUFMgZnJvbSBEb2NrZXIgbWFuYWdlcnMnKTtcclxuICAgIGVuZHBvaW50U2cuYWRkSW5ncmVzc1J1bGUod29ya2VyU2csIGVjMi5Qb3J0LnRjcCg0NDMpLCAnSFRUUFMgZnJvbSBEb2NrZXIgd29ya2VycycpO1xyXG5cclxuICAgIGNvbnN0IGVuYWJsZVZwY0Ruc1N1cHBvcnQgPSBuZXcgY3IuQXdzQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0VuYWJsZURvY2tlclZwY0Ruc1N1cHBvcnQnLCB7XHJcbiAgICAgIG9uQ3JlYXRlOiB7XHJcbiAgICAgICAgc2VydmljZTogJ0VDMicsXHJcbiAgICAgICAgYWN0aW9uOiAnbW9kaWZ5VnBjQXR0cmlidXRlJyxcclxuICAgICAgICBwYXJhbWV0ZXJzOiB7XHJcbiAgICAgICAgICBWcGNJZDogdnBjLnZwY0lkLFxyXG4gICAgICAgICAgRW5hYmxlRG5zU3VwcG9ydDogeyBWYWx1ZTogdHJ1ZSB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiBjci5QaHlzaWNhbFJlc291cmNlSWQub2YoYCR7cGFyYW1zLnZwY0lkfS1kbnMtc3VwcG9ydGApLFxyXG4gICAgICB9LFxyXG4gICAgICBvblVwZGF0ZToge1xyXG4gICAgICAgIHNlcnZpY2U6ICdFQzInLFxyXG4gICAgICAgIGFjdGlvbjogJ21vZGlmeVZwY0F0dHJpYnV0ZScsXHJcbiAgICAgICAgcGFyYW1ldGVyczoge1xyXG4gICAgICAgICAgVnBjSWQ6IHZwYy52cGNJZCxcclxuICAgICAgICAgIEVuYWJsZURuc1N1cHBvcnQ6IHsgVmFsdWU6IHRydWUgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogY3IuUGh5c2ljYWxSZXNvdXJjZUlkLm9mKGAke3BhcmFtcy52cGNJZH0tZG5zLXN1cHBvcnRgKSxcclxuICAgICAgfSxcclxuICAgICAgcG9saWN5OiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5mcm9tU2RrQ2FsbHMoe1xyXG4gICAgICAgIHJlc291cmNlczogY3IuQXdzQ3VzdG9tUmVzb3VyY2VQb2xpY3kuQU5ZX1JFU09VUkNFLFxyXG4gICAgICB9KSxcclxuICAgIH0pO1xyXG4gICAgY29uc3QgZW5hYmxlVnBjRG5zSG9zdG5hbWVzID0gbmV3IGNyLkF3c0N1c3RvbVJlc291cmNlKHRoaXMsICdFbmFibGVEb2NrZXJWcGNEbnNIb3N0bmFtZXMnLCB7XHJcbiAgICAgIG9uQ3JlYXRlOiB7XHJcbiAgICAgICAgc2VydmljZTogJ0VDMicsXHJcbiAgICAgICAgYWN0aW9uOiAnbW9kaWZ5VnBjQXR0cmlidXRlJyxcclxuICAgICAgICBwYXJhbWV0ZXJzOiB7XHJcbiAgICAgICAgICBWcGNJZDogdnBjLnZwY0lkLFxyXG4gICAgICAgICAgRW5hYmxlRG5zSG9zdG5hbWVzOiB7IFZhbHVlOiB0cnVlIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICBwaHlzaWNhbFJlc291cmNlSWQ6IGNyLlBoeXNpY2FsUmVzb3VyY2VJZC5vZihgJHtwYXJhbXMudnBjSWR9LWRucy1ob3N0bmFtZXNgKSxcclxuICAgICAgfSxcclxuICAgICAgb25VcGRhdGU6IHtcclxuICAgICAgICBzZXJ2aWNlOiAnRUMyJyxcclxuICAgICAgICBhY3Rpb246ICdtb2RpZnlWcGNBdHRyaWJ1dGUnLFxyXG4gICAgICAgIHBhcmFtZXRlcnM6IHtcclxuICAgICAgICAgIFZwY0lkOiB2cGMudnBjSWQsXHJcbiAgICAgICAgICBFbmFibGVEbnNIb3N0bmFtZXM6IHsgVmFsdWU6IHRydWUgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogY3IuUGh5c2ljYWxSZXNvdXJjZUlkLm9mKGAke3BhcmFtcy52cGNJZH0tZG5zLWhvc3RuYW1lc2ApLFxyXG4gICAgICB9LFxyXG4gICAgICBwb2xpY3k6IGNyLkF3c0N1c3RvbVJlc291cmNlUG9saWN5LmZyb21TZGtDYWxscyh7XHJcbiAgICAgICAgcmVzb3VyY2VzOiBjci5Bd3NDdXN0b21SZXNvdXJjZVBvbGljeS5BTllfUkVTT1VSQ0UsXHJcbiAgICAgIH0pLFxyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3Qgc3NtRW5kcG9pbnQgPSB2cGMuYWRkSW50ZXJmYWNlRW5kcG9pbnQoJ0RvY2tlclNzbUVuZHBvaW50Jywge1xyXG4gICAgICBzZXJ2aWNlOiBlYzIuSW50ZXJmYWNlVnBjRW5kcG9pbnRBd3NTZXJ2aWNlLlNTTSxcclxuICAgICAgc3VibmV0czogdnBjU3VibmV0cyxcclxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtlbmRwb2ludFNnXSxcclxuICAgICAgcHJpdmF0ZURuc0VuYWJsZWQ6IHRydWUsXHJcbiAgICB9KTtcclxuICAgIGNkay5UYWdzLm9mKHNzbUVuZHBvaW50KS5hZGQoJ05hbWUnLCBgJHtjZGsuU3RhY2sub2YodGhpcykuc3RhY2tOYW1lfS1zc20tZW5kcG9pbnRgKTtcclxuICAgIGNvbnN0IGVjMk1lc3NhZ2VzRW5kcG9pbnQgPSB2cGMuYWRkSW50ZXJmYWNlRW5kcG9pbnQoJ0RvY2tlckVjMk1lc3NhZ2VzRW5kcG9pbnQnLCB7XHJcbiAgICAgIHNlcnZpY2U6IGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UuRUMyX01FU1NBR0VTLFxyXG4gICAgICBzdWJuZXRzOiB2cGNTdWJuZXRzLFxyXG4gICAgICBzZWN1cml0eUdyb3VwczogW2VuZHBvaW50U2ddLFxyXG4gICAgICBwcml2YXRlRG5zRW5hYmxlZDogdHJ1ZSxcclxuICAgIH0pO1xyXG4gICAgY2RrLlRhZ3Mub2YoZWMyTWVzc2FnZXNFbmRwb2ludCkuYWRkKCdOYW1lJywgYCR7Y2RrLlN0YWNrLm9mKHRoaXMpLnN0YWNrTmFtZX0tZWMybWVzc2FnZXMtZW5kcG9pbnRgKTtcclxuICAgIGNvbnN0IHNzbU1lc3NhZ2VzRW5kcG9pbnQgPSB2cGMuYWRkSW50ZXJmYWNlRW5kcG9pbnQoJ0RvY2tlclNzbU1lc3NhZ2VzRW5kcG9pbnQnLCB7XHJcbiAgICAgIHNlcnZpY2U6IGVjMi5JbnRlcmZhY2VWcGNFbmRwb2ludEF3c1NlcnZpY2UuU1NNX01FU1NBR0VTLFxyXG4gICAgICBzdWJuZXRzOiB2cGNTdWJuZXRzLFxyXG4gICAgICBzZWN1cml0eUdyb3VwczogW2VuZHBvaW50U2ddLFxyXG4gICAgICBwcml2YXRlRG5zRW5hYmxlZDogdHJ1ZSxcclxuICAgIH0pO1xyXG4gICAgY2RrLlRhZ3Mub2Yoc3NtTWVzc2FnZXNFbmRwb2ludCkuYWRkKCdOYW1lJywgYCR7Y2RrLlN0YWNrLm9mKHRoaXMpLnN0YWNrTmFtZX0tc3NtbWVzc2FnZXMtZW5kcG9pbnRgKTtcclxuICAgIFtzc21FbmRwb2ludCwgZWMyTWVzc2FnZXNFbmRwb2ludCwgc3NtTWVzc2FnZXNFbmRwb2ludF0uZm9yRWFjaCgoZW5kcG9pbnQpID0+IHtcclxuICAgICAgZW5kcG9pbnQubm9kZS5hZGREZXBlbmRlbmN5KGVuYWJsZVZwY0Ruc1N1cHBvcnQpO1xyXG4gICAgICBlbmRwb2ludC5ub2RlLmFkZERlcGVuZGVuY3koZW5hYmxlVnBjRG5zSG9zdG5hbWVzKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IGluc3RhbmNlUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnRG9ja2VySW5zdGFuY2VSb2xlJywge1xyXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWMyLmFtYXpvbmF3cy5jb20nKSxcclxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXHJcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdBbWF6b25TU01NYW5hZ2VkSW5zdGFuY2VDb3JlJyksXHJcbiAgICAgIF0sXHJcbiAgICB9KTtcclxuICAgIGluc3RhbmNlUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGFjdGlvbnM6IFsnc3NtOkdldFBhcmFtZXRlcicsICdzc206UHV0UGFyYW1ldGVyJ10sXHJcbiAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgIGNkay5TdGFjay5vZih0aGlzKS5mb3JtYXRBcm4oe1xyXG4gICAgICAgICAgc2VydmljZTogJ3NzbScsXHJcbiAgICAgICAgICByZXNvdXJjZTogJ3BhcmFtZXRlcicsXHJcbiAgICAgICAgICByZXNvdXJjZU5hbWU6IGBkb2NrZXItc3dhcm0vJHtjZGsuU3RhY2sub2YodGhpcykuc3RhY2tOYW1lfS8qYCxcclxuICAgICAgICB9KSxcclxuICAgICAgXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICBjb25zdCBhbWkgPSBlYzIuTWFjaGluZUltYWdlLmdlbmVyaWNMaW51eCh7XHJcbiAgICAgIFtjZGsuU3RhY2sub2YodGhpcykucmVnaW9uXTogcGFyYW1zLmFtaUlkLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBpbnN0YW5jZVR5cGUgPSBuZXcgZWMyLkluc3RhbmNlVHlwZShwYXJhbXMuaW5zdGFuY2VUeXBlKTtcclxuICAgIGNvbnN0IHNzaEtleVBhaXIgPSBuZXcgZWMyLktleVBhaXIodGhpcywgJ0RvY2tlclNzaEtleVBhaXInLCB7XHJcbiAgICAgIGtleVBhaXJOYW1lOiBzc2hLZXlOYW1lLFxyXG4gICAgICBmb3JtYXQ6IGVjMi5LZXlQYWlyRm9ybWF0LlBFTSxcclxuICAgICAgdHlwZTogZWMyLktleVBhaXJUeXBlLlJTQSxcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IG1hbmFnZXJVc2VyRGF0YSA9IGVjMi5Vc2VyRGF0YS5mb3JMaW51eCgpO1xyXG4gICAgbWFuYWdlclVzZXJEYXRhLmFkZENvbW1hbmRzKFxyXG4gICAgICAnc2V0IC1ldXhvIHBpcGVmYWlsJyxcclxuICAgICAgJ1RPS0VOPSQoY3VybCAtWCBQVVQgXCJodHRwOi8vMTY5LjI1NC4xNjkuMjU0L2xhdGVzdC9hcGkvdG9rZW5cIiAtSCBcIlgtYXdzLWVjMi1tZXRhZGF0YS10b2tlbi10dGwtc2Vjb25kczogMjE2MDBcIiknLFxyXG4gICAgICAnUFJJVkFURV9JUD0kKGN1cmwgLUggXCJYLWF3cy1lYzItbWV0YWRhdGEtdG9rZW46ICRUT0tFTlwiIGh0dHA6Ly8xNjkuMjU0LjE2OS4yNTQvbGF0ZXN0L21ldGEtZGF0YS9sb2NhbC1pcHY0KScsXHJcbiAgICAgIGBpZiBhd3Mgc3NtIHB1dC1wYXJhbWV0ZXIgLS1yZWdpb24gJHtjZGsuU3RhY2sub2YodGhpcykucmVnaW9ufSAtLW5hbWUgXCIke2Jvb3RzdHJhcE1hbmFnZXJJcFBhcmFtZXRlck5hbWV9XCIgLS10eXBlIFN0cmluZyAtLXZhbHVlIFwiJFBSSVZBVEVfSVBcIiAtLW5vLW92ZXJ3cml0ZTsgdGhlbmAsXHJcbiAgICAgICcgIGRvY2tlciBpbmZvIC0tZm9ybWF0IFwie3suU3dhcm0uTG9jYWxOb2RlU3RhdGV9fVwiIHwgZ3JlcCAtcSBcIl5hY3RpdmUkXCIgfHwgZG9ja2VyIHN3YXJtIGluaXQgLS1hZHZlcnRpc2UtYWRkciBcIiRQUklWQVRFX0lQXCInLFxyXG4gICAgICAnICBNQU5BR0VSX1RPS0VOPSQoZG9ja2VyIHN3YXJtIGpvaW4tdG9rZW4gbWFuYWdlciAtcSknLFxyXG4gICAgICAnICBXT1JLRVJfVE9LRU49JChkb2NrZXIgc3dhcm0gam9pbi10b2tlbiB3b3JrZXIgLXEpJyxcclxuICAgICAgYCAgYXdzIHNzbSBwdXQtcGFyYW1ldGVyIC0tcmVnaW9uICR7Y2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbn0gLS1uYW1lIFwiJHttYW5hZ2VySm9pbkNvbW1hbmRQYXJhbWV0ZXJOYW1lfVwiIC0tdHlwZSBTZWN1cmVTdHJpbmcgLS1vdmVyd3JpdGUgLS12YWx1ZSBcImRvY2tlciBzd2FybSBqb2luIC0tdG9rZW4gJE1BTkFHRVJfVE9LRU4gJFBSSVZBVEVfSVA6MjM3N1wiYCxcclxuICAgICAgYCAgYXdzIHNzbSBwdXQtcGFyYW1ldGVyIC0tcmVnaW9uICR7Y2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbn0gLS1uYW1lIFwiJHt3b3JrZXJKb2luQ29tbWFuZFBhcmFtZXRlck5hbWV9XCIgLS10eXBlIFNlY3VyZVN0cmluZyAtLW92ZXJ3cml0ZSAtLXZhbHVlIFwiZG9ja2VyIHN3YXJtIGpvaW4gLS10b2tlbiAkV09SS0VSX1RPS0VOICRQUklWQVRFX0lQOjIzNzdcImAsXHJcbiAgICAgICdlbHNlJyxcclxuICAgICAgYCAgZm9yIGkgaW4gJChzZXEgMSA2MCk7IGRvIE1BTkFHRVJfSk9JTl9DT01NQU5EPSQoYXdzIHNzbSBnZXQtcGFyYW1ldGVyIC0tcmVnaW9uICR7Y2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbn0gLS1uYW1lIFwiJHttYW5hZ2VySm9pbkNvbW1hbmRQYXJhbWV0ZXJOYW1lfVwiIC0td2l0aC1kZWNyeXB0aW9uIC0tcXVlcnkgUGFyYW1ldGVyLlZhbHVlIC0tb3V0cHV0IHRleHQgMj4vZGV2L251bGwpICYmIGJyZWFrOyBzbGVlcCAxMDsgZG9uZWAsXHJcbiAgICAgICcgIHRlc3QgLW4gXCIke01BTkFHRVJfSk9JTl9DT01NQU5EOi19XCInLFxyXG4gICAgICAnICBkb2NrZXIgaW5mbyAtLWZvcm1hdCBcInt7LlN3YXJtLkxvY2FsTm9kZVN0YXRlfX1cIiB8IGdyZXAgLXEgXCJeYWN0aXZlJFwiIHx8ICRNQU5BR0VSX0pPSU5fQ09NTUFORCcsXHJcbiAgICAgICdmaScsXHJcbiAgICApO1xyXG5cclxuICAgIGNvbnN0IGRvY2tlck1hbmFnZXJBc2cgPSBuZXcgYXV0b3NjYWxpbmcuQXV0b1NjYWxpbmdHcm91cCh0aGlzLCAnRG9ja2VyTWFuYWdlckFzZycsIHtcclxuICAgICAgdnBjLFxyXG4gICAgICB2cGNTdWJuZXRzLFxyXG4gICAgICBpbnN0YW5jZVR5cGUsXHJcbiAgICAgIG1hY2hpbmVJbWFnZTogYW1pLFxyXG4gICAgICBzZWN1cml0eUdyb3VwOiBtYW5hZ2VyU2csXHJcbiAgICAgIHJvbGU6IGluc3RhbmNlUm9sZSxcclxuICAgICAga2V5UGFpcjogc3NoS2V5UGFpcixcclxuICAgICAgdXNlckRhdGE6IG1hbmFnZXJVc2VyRGF0YSxcclxuICAgICAgbWluQ2FwYWNpdHk6IDIsXHJcbiAgICAgIG1heENhcGFjaXR5OiA0LFxyXG4gICAgICBkZXNpcmVkQ2FwYWNpdHk6IDIsXHJcbiAgICB9KTtcclxuICAgIGRvY2tlck1hbmFnZXJBc2cubm9kZS5hZGREZXBlbmRlbmN5KHNzaEtleVBhaXIpO1xyXG4gICAgY2RrLlRhZ3Mub2YoZG9ja2VyTWFuYWdlckFzZykuYWRkKCdOYW1lJywgJ2RvY2tlci1zd2FybS1tYW5hZ2VyJyk7XHJcblxyXG4gICAgY29uc3Qgd29ya2VyVXNlckRhdGEgPSBlYzIuVXNlckRhdGEuZm9yTGludXgoKTtcclxuICAgIHdvcmtlclVzZXJEYXRhLmFkZENvbW1hbmRzKFxyXG4gICAgICAnc2V0IC1ldXhvIHBpcGVmYWlsJyxcclxuICAgICAgYGZvciBpIGluICQoc2VxIDEgNjApOyBkbyBKT0lOX0NPTU1BTkQ9JChhd3Mgc3NtIGdldC1wYXJhbWV0ZXIgLS1yZWdpb24gJHtjZGsuU3RhY2sub2YodGhpcykucmVnaW9ufSAtLW5hbWUgXCIke3dvcmtlckpvaW5Db21tYW5kUGFyYW1ldGVyTmFtZX1cIiAtLXdpdGgtZGVjcnlwdGlvbiAtLXF1ZXJ5IFBhcmFtZXRlci5WYWx1ZSAtLW91dHB1dCB0ZXh0IDI+L2Rldi9udWxsKSAmJiBicmVhazsgc2xlZXAgMTA7IGRvbmVgLFxyXG4gICAgICAndGVzdCAtbiBcIiR7Sk9JTl9DT01NQU5EOi19XCInLFxyXG4gICAgICAnZG9ja2VyIGluZm8gLS1mb3JtYXQgXCJ7ey5Td2FybS5Mb2NhbE5vZGVTdGF0ZX19XCIgfCBncmVwIC1xIFwiXmFjdGl2ZSRcIiB8fCAkSk9JTl9DT01NQU5EJyxcclxuICAgICk7XHJcblxyXG4gICAgY29uc3QgZG9ja2VyV29ya2VyQXNnID0gbmV3IGF1dG9zY2FsaW5nLkF1dG9TY2FsaW5nR3JvdXAodGhpcywgJ0RvY2tlcldvcmtlckFzZycsIHtcclxuICAgICAgdnBjLFxyXG4gICAgICB2cGNTdWJuZXRzLFxyXG4gICAgICBpbnN0YW5jZVR5cGUsXHJcbiAgICAgIG1hY2hpbmVJbWFnZTogYW1pLFxyXG4gICAgICBzZWN1cml0eUdyb3VwOiB3b3JrZXJTZyxcclxuICAgICAgcm9sZTogaW5zdGFuY2VSb2xlLFxyXG4gICAgICBrZXlQYWlyOiBzc2hLZXlQYWlyLFxyXG4gICAgICB1c2VyRGF0YTogd29ya2VyVXNlckRhdGEsXHJcbiAgICAgIG1pbkNhcGFjaXR5OiAyLFxyXG4gICAgICBtYXhDYXBhY2l0eTogNCxcclxuICAgICAgZGVzaXJlZENhcGFjaXR5OiAyLFxyXG4gICAgfSk7XHJcbiAgICBkb2NrZXJXb3JrZXJBc2cubm9kZS5hZGREZXBlbmRlbmN5KHNzaEtleVBhaXIpO1xyXG4gICAgZG9ja2VyV29ya2VyQXNnLm5vZGUuYWRkRGVwZW5kZW5jeShkb2NrZXJNYW5hZ2VyQXNnKTtcclxuICAgIGNkay5UYWdzLm9mKGRvY2tlcldvcmtlckFzZykuYWRkKCdOYW1lJywgJ2RvY2tlci1zd2FybS13b3JrZXInKTtcclxuXHJcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRG9ja2VyTWFuYWdlckFzZ05hbWUnLCB7XHJcbiAgICAgIHZhbHVlOiBkb2NrZXJNYW5hZ2VyQXNnLmF1dG9TY2FsaW5nR3JvdXBOYW1lLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ0RvY2tlciBTd2FybSBtYW5hZ2VyIEF1dG8gU2NhbGluZyBHcm91cCBuYW1lJyxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEb2NrZXJXb3JrZXJBc2dOYW1lJywge1xyXG4gICAgICB2YWx1ZTogZG9ja2VyV29ya2VyQXNnLmF1dG9TY2FsaW5nR3JvdXBOYW1lLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ0RvY2tlciBTd2FybSB3b3JrZXIgQXV0byBTY2FsaW5nIEdyb3VwIG5hbWUnLFxyXG4gICAgfSk7XHJcblxyXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RvY2tlclNzaEtleVBhaXJOYW1lJywge1xyXG4gICAgICB2YWx1ZTogc3NoS2V5UGFpci5rZXlQYWlyTmFtZSxcclxuICAgICAgZGVzY3JpcHRpb246ICdTU0gga2V5IHBhaXIgbmFtZSBmb3IgRG9ja2VyIFN3YXJtIEVDMiBpbnN0YW5jZXMnLFxyXG4gICAgfSk7XHJcblxyXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RvY2tlcldvcmtlckpvaW5Db21tYW5kUGFyYW1ldGVyTmFtZScsIHtcclxuICAgICAgdmFsdWU6IHdvcmtlckpvaW5Db21tYW5kUGFyYW1ldGVyTmFtZSxcclxuICAgICAgZGVzY3JpcHRpb246ICdTU00gU2VjdXJlU3RyaW5nIHBhcmFtZXRlciBjb250YWluaW5nIHRoZSBEb2NrZXIgU3dhcm0gd29ya2VyIGpvaW4gY29tbWFuZCcsXHJcbiAgICB9KTtcclxuXHJcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRG9ja2VyTWFuYWdlckpvaW5Db21tYW5kUGFyYW1ldGVyTmFtZScsIHtcclxuICAgICAgdmFsdWU6IG1hbmFnZXJKb2luQ29tbWFuZFBhcmFtZXRlck5hbWUsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnU1NNIFNlY3VyZVN0cmluZyBwYXJhbWV0ZXIgY29udGFpbmluZyB0aGUgRG9ja2VyIFN3YXJtIG1hbmFnZXIgam9pbiBjb21tYW5kJyxcclxuICAgIH0pO1xyXG4gIH1cclxufVxyXG4iXX0=