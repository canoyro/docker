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
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const params = JSON.parse(fs.readFileSync(path.join(__dirname, '../parameters.json'), 'utf-8'));
class DockerStack extends cdk.Stack {
    constructor(scope, id, props) {
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
        dockerManager.userData.addCommands('set -euxo pipefail', 'TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")', 'PRIVATE_IP=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)', 'docker info --format "{{.Swarm.LocalNodeState}}" | grep -q "^active$" || docker swarm init --advertise-addr "$PRIVATE_IP"', 'JOIN_TOKEN=$(docker swarm join-token worker -q)', `aws ssm put-parameter --region ${cdk.Stack.of(this).region} --name "${workerJoinCommandParameterName}" --type SecureString --overwrite --value "docker swarm join --token $JOIN_TOKEN $PRIVATE_IP:2377"`);
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
        dockerWorker.userData.addCommands('set -euxo pipefail', `for i in $(seq 1 60); do JOIN_COMMAND=$(aws ssm get-parameter --region ${cdk.Stack.of(this).region} --name "${workerJoinCommandParameterName}" --with-decryption --query Parameter.Value --output text 2>/dev/null) && break; sleep 10; done`, 'test -n "${JOIN_COMMAND:-}"', 'docker info --format "{{.Swarm.LocalNodeState}}" | grep -q "^active$" || $JOIN_COMMAND');
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
exports.DockerStack = DockerStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZG9ja2VyLXByb2otc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJkb2NrZXItcHJvai1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxzREFBd0M7QUFDeEMseURBQTJDO0FBQzNDLHlEQUEyQztBQUUzQyx1Q0FBeUI7QUFDekIsMkNBQTZCO0FBUzdCLE1BQU0sTUFBTSxHQUFpQixJQUFJLENBQUMsS0FBSyxDQUNyQyxFQUFFLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLG9CQUFvQixDQUFDLEVBQUUsT0FBTyxDQUFDLENBQ3JFLENBQUM7QUFFRixNQUFhLFdBQVksU0FBUSxHQUFHLENBQUMsS0FBSztJQUN4QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sOEJBQThCLEdBQUcsaUJBQWlCLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLFNBQVMsc0JBQXNCLENBQUM7UUFDM0csTUFBTSxVQUFVLEdBQUcsR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxTQUFTLENBQUMsV0FBVyxFQUFFLFVBQVUsQ0FBQztRQUUzRSxNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFLEVBQUUsS0FBSyxFQUFFLE1BQU0sQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO1FBRTNFLE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDakUsS0FBSyxFQUFFLEdBQUcsQ0FBQyxLQUFLO1lBQ2hCLElBQUksRUFBRTtnQkFDSjtvQkFDRSxHQUFHLEVBQUUsTUFBTTtvQkFDWCxLQUFLLEVBQUUsR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxTQUFTLHFCQUFxQjtpQkFDNUQ7YUFDRjtTQUNGLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLDhCQUE4QixDQUFDLElBQUksRUFBRSxtQ0FBbUMsRUFBRTtZQUNoRixRQUFRLEVBQUUsTUFBTSxDQUFDLFFBQVE7WUFDekIsWUFBWSxFQUFFLFVBQVUsQ0FBQyxHQUFHO1NBQzdCLENBQUMsQ0FBQztRQUVILE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxNQUFNLENBQUMsb0JBQW9CLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUNuRSxRQUFRLEVBQUUsTUFBTSxDQUFDLFFBQVE7WUFDekIsZ0JBQWdCLEVBQUUsTUFBTSxDQUFDLGdCQUFnQjtZQUN6QyxZQUFZLEVBQUUsVUFBVSxDQUFDLEdBQUc7U0FDN0IsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxVQUFVLEdBQUcsRUFBRSxPQUFPLEVBQUUsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBRXpDLHlCQUF5QjtRQUN6QixNQUFNLFNBQVMsR0FBRyxJQUFJLEdBQUcsQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQy9ELEdBQUc7WUFDSCxpQkFBaUIsRUFBRSxtQkFBbUI7WUFDdEMsV0FBVyxFQUFFLHFDQUFxQztZQUNsRCxnQkFBZ0IsRUFBRSxJQUFJO1lBQ3RCLGtCQUFrQixFQUFFLElBQUk7U0FDekIsQ0FBQyxDQUFDO1FBRUgsd0JBQXdCO1FBQ3hCLE1BQU0sUUFBUSxHQUFHLElBQUksR0FBRyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDN0QsR0FBRztZQUNILGlCQUFpQixFQUFFLGtCQUFrQjtZQUNyQyxXQUFXLEVBQUUsb0NBQW9DO1lBQ2pELGdCQUFnQixFQUFFLElBQUk7WUFDdEIsa0JBQWtCLEVBQUUsSUFBSTtTQUN6QixDQUFDLENBQUM7UUFFSCxnQ0FBZ0M7UUFDaEMsU0FBUyxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3RFLDZDQUE2QztRQUM3QyxTQUFTLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSx5QkFBeUIsQ0FBQyxDQUFDO1FBQzVILDBDQUEwQztRQUMxQyxTQUFTLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSw0QkFBNEIsQ0FBQyxDQUFDO1FBQy9ILFNBQVMsQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLDRCQUE0QixDQUFDLENBQUM7UUFDL0gsK0JBQStCO1FBQy9CLFNBQVMsQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLDhCQUE4QixDQUFDLENBQUM7UUFFakksK0JBQStCO1FBQy9CLFFBQVEsQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUNyRSwwQ0FBMEM7UUFDMUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxTQUFTLENBQUMsZUFBZSxDQUFDLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsNEJBQTRCLENBQUMsQ0FBQztRQUMvSCxRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSw0QkFBNEIsQ0FBQyxDQUFDO1FBQy9ILCtCQUErQjtRQUMvQixRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSw4QkFBOEIsQ0FBQyxDQUFDO1FBQ2pJLHdEQUF3RDtRQUN4RCxRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSwrQkFBK0IsQ0FBQyxDQUFDO1FBQ2pJLFFBQVEsQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsUUFBUSxDQUFDLGVBQWUsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLCtCQUErQixDQUFDLENBQUM7UUFDakksUUFBUSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxRQUFRLENBQUMsZUFBZSxDQUFDLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsaUNBQWlDLENBQUMsQ0FBQztRQUVuSSxNQUFNLFlBQVksR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFO1lBQzVELFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxtQkFBbUIsQ0FBQztZQUN4RCxlQUFlLEVBQUU7Z0JBQ2YsR0FBRyxDQUFDLGFBQWEsQ0FBQyx3QkFBd0IsQ0FBQyw4QkFBOEIsQ0FBQzthQUMzRTtTQUNGLENBQUMsQ0FBQztRQUNILFlBQVksQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQy9DLE9BQU8sRUFBRSxDQUFDLGtCQUFrQixFQUFFLGtCQUFrQixDQUFDO1lBQ2pELFNBQVMsRUFBRTtnQkFDVCxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxTQUFTLENBQUM7b0JBQzNCLE9BQU8sRUFBRSxLQUFLO29CQUNkLFFBQVEsRUFBRSxXQUFXO29CQUNyQixZQUFZLEVBQUUsOEJBQThCLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUM7aUJBQ2hFLENBQUM7YUFDSDtTQUNGLENBQUMsQ0FBQyxDQUFDO1FBRUosTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLFlBQVksQ0FBQyxZQUFZLENBQUM7WUFDeEMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBRSxNQUFNLENBQUMsS0FBSztTQUMxQyxDQUFDLENBQUM7UUFDSCxNQUFNLFlBQVksR0FBRyxHQUFHLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLFFBQVEsRUFBRSxHQUFHLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzdGLE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDM0QsV0FBVyxFQUFFLFVBQVU7WUFDdkIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsR0FBRztZQUM3QixJQUFJLEVBQUUsR0FBRyxDQUFDLFdBQVcsQ0FBQyxHQUFHO1NBQzFCLENBQUMsQ0FBQztRQUVILE1BQU0sYUFBYSxHQUFHLElBQUksR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsZUFBZSxFQUFFO1lBQzVELFlBQVksRUFBRSxzQkFBc0I7WUFDcEMsR0FBRztZQUNILFVBQVU7WUFDVixZQUFZO1lBQ1osWUFBWSxFQUFFLEdBQUc7WUFDakIsYUFBYSxFQUFFLFNBQVM7WUFDeEIsSUFBSSxFQUFFLFlBQVk7WUFDbEIsT0FBTyxFQUFFLFVBQVU7U0FDcEIsQ0FBQyxDQUFDO1FBQ0gsYUFBYSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDN0MsYUFBYSxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQ2hDLG9CQUFvQixFQUNwQixpSEFBaUgsRUFDakgsNkdBQTZHLEVBQzdHLDJIQUEySCxFQUMzSCxpREFBaUQsRUFDakQsa0NBQWtDLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sWUFBWSw4QkFBOEIsb0dBQW9HLENBQzFNLENBQUM7UUFFRixNQUFNLFlBQVksR0FBRyxJQUFJLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUMxRCxZQUFZLEVBQUUscUJBQXFCO1lBQ25DLEdBQUc7WUFDSCxVQUFVO1lBQ1YsWUFBWTtZQUNaLFlBQVksRUFBRSxHQUFHO1lBQ2pCLGFBQWEsRUFBRSxRQUFRO1lBQ3ZCLElBQUksRUFBRSxZQUFZO1lBQ2xCLE9BQU8sRUFBRSxVQUFVO1NBQ3BCLENBQUMsQ0FBQztRQUNILFlBQVksQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQzVDLFlBQVksQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUMvQixvQkFBb0IsRUFDcEIsMEVBQTBFLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sWUFBWSw4QkFBOEIsaUdBQWlHLEVBQzlPLDZCQUE2QixFQUM3Qix3RkFBd0YsQ0FDekYsQ0FBQztRQUNGLFlBQVksQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBRS9DLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsd0JBQXdCLEVBQUU7WUFDaEQsS0FBSyxFQUFFLGFBQWEsQ0FBQyxpQkFBaUI7WUFDdEMsV0FBVyxFQUFFLGlDQUFpQztTQUMvQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHVCQUF1QixFQUFFO1lBQy9DLEtBQUssRUFBRSxZQUFZLENBQUMsaUJBQWlCO1lBQ3JDLFdBQVcsRUFBRSxnQ0FBZ0M7U0FDOUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxzQkFBc0IsRUFBRTtZQUM5QyxLQUFLLEVBQUUsVUFBVSxDQUFDLFdBQVc7WUFDN0IsV0FBVyxFQUFFLGtEQUFrRDtTQUNoRSxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHNDQUFzQyxFQUFFO1lBQzlELEtBQUssRUFBRSw4QkFBOEI7WUFDckMsV0FBVyxFQUFFLDRFQUE0RTtTQUMxRixDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUE3SkQsa0NBNkpDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliL2NvcmUnO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuXG5pbnRlcmZhY2UgRG9ja2VyUGFyYW1zIHtcbiAgdnBjSWQ6IHN0cmluZztcbiAgc3VibmV0SWQ6IHN0cmluZztcbiAgYXZhaWxhYmlsaXR5Wm9uZTogc3RyaW5nO1xuICBhbWlJZDogc3RyaW5nO1xufVxuXG5jb25zdCBwYXJhbXM6IERvY2tlclBhcmFtcyA9IEpTT04ucGFyc2UoXG4gIGZzLnJlYWRGaWxlU3luYyhwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vcGFyYW1ldGVycy5qc29uJyksICd1dGYtOCcpXG4pO1xuXG5leHBvcnQgY2xhc3MgRG9ja2VyU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCB3b3JrZXJKb2luQ29tbWFuZFBhcmFtZXRlck5hbWUgPSBgL2RvY2tlci1zd2FybS8ke2Nkay5TdGFjay5vZih0aGlzKS5zdGFja05hbWV9L3dvcmtlci1qb2luLWNvbW1hbmRgO1xuICAgIGNvbnN0IHNzaEtleU5hbWUgPSBgJHtjZGsuU3RhY2sub2YodGhpcykuc3RhY2tOYW1lLnRvTG93ZXJDYXNlKCl9LXNzaC1rZXlgO1xuXG4gICAgY29uc3QgdnBjID0gZWMyLlZwYy5mcm9tTG9va3VwKHRoaXMsICdEb2NrZXJWcGMnLCB7IHZwY0lkOiBwYXJhbXMudnBjSWQgfSk7XG5cbiAgICBjb25zdCByb3V0ZVRhYmxlID0gbmV3IGVjMi5DZm5Sb3V0ZVRhYmxlKHRoaXMsICdEb2NrZXJSb3V0ZVRhYmxlJywge1xuICAgICAgdnBjSWQ6IHZwYy52cGNJZCxcbiAgICAgIHRhZ3M6IFtcbiAgICAgICAge1xuICAgICAgICAgIGtleTogJ05hbWUnLFxuICAgICAgICAgIHZhbHVlOiBgJHtjZGsuU3RhY2sub2YodGhpcykuc3RhY2tOYW1lfS1kb2NrZXItcm91dGUtdGFibGVgLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcblxuICAgIG5ldyBlYzIuQ2ZuU3VibmV0Um91dGVUYWJsZUFzc29jaWF0aW9uKHRoaXMsICdEb2NrZXJTdWJuZXRSb3V0ZVRhYmxlQXNzb2NpYXRpb24nLCB7XG4gICAgICBzdWJuZXRJZDogcGFyYW1zLnN1Ym5ldElkLFxuICAgICAgcm91dGVUYWJsZUlkOiByb3V0ZVRhYmxlLnJlZixcbiAgICB9KTtcblxuICAgIGNvbnN0IHN1Ym5ldCA9IGVjMi5TdWJuZXQuZnJvbVN1Ym5ldEF0dHJpYnV0ZXModGhpcywgJ0RvY2tlclN1Ym5ldCcsIHtcbiAgICAgIHN1Ym5ldElkOiBwYXJhbXMuc3VibmV0SWQsXG4gICAgICBhdmFpbGFiaWxpdHlab25lOiBwYXJhbXMuYXZhaWxhYmlsaXR5Wm9uZSxcbiAgICAgIHJvdXRlVGFibGVJZDogcm91dGVUYWJsZS5yZWYsXG4gICAgfSk7XG4gICAgY29uc3QgdnBjU3VibmV0cyA9IHsgc3VibmV0czogW3N1Ym5ldF0gfTtcblxuICAgIC8vIE1hbmFnZXIgc2VjdXJpdHkgZ3JvdXBcbiAgICBjb25zdCBtYW5hZ2VyU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0RvY2tlck1hbmFnZXJTZycsIHtcbiAgICAgIHZwYyxcbiAgICAgIHNlY3VyaXR5R3JvdXBOYW1lOiAnZG9ja2VyLW1hbmFnZXItc2cnLFxuICAgICAgZGVzY3JpcHRpb246ICdEb2NrZXIgU3dhcm0gbWFuYWdlciBzZWN1cml0eSBncm91cCcsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgICAgZGlzYWJsZUlubGluZVJ1bGVzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gV29ya2VyIHNlY3VyaXR5IGdyb3VwXG4gICAgY29uc3Qgd29ya2VyU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0RvY2tlcldvcmtlclNnJywge1xuICAgICAgdnBjLFxuICAgICAgc2VjdXJpdHlHcm91cE5hbWU6ICdkb2NrZXItd29ya2VyLXNnJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRG9ja2VyIFN3YXJtIHdvcmtlciBzZWN1cml0eSBncm91cCcsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgICAgZGlzYWJsZUlubGluZVJ1bGVzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gLS0tIE1hbmFnZXIgaW5ncmVzcyBydWxlcyAtLS1cbiAgICBtYW5hZ2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuYW55SXB2NCgpLCBlYzIuUG9ydC50Y3AoMjIpLCAnU1NIJyk7XG4gICAgLy8gV29ya2VycyBqb2luIHRoZSBzd2FybSB2aWEgbWFuYWdlciBvbiAyMzc3XG4gICAgbWFuYWdlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZCh3b3JrZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC50Y3AoMjM3NyksICdTd2FybSBqb2luIGZyb20gd29ya2VycycpO1xuICAgIC8vIE5vZGUtdG8tbm9kZSBjb21tdW5pY2F0aW9uIGZyb20gd29ya2Vyc1xuICAgIG1hbmFnZXJTZy5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5zZWN1cml0eUdyb3VwSWQod29ya2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudGNwKDc5NDYpLCAnTm9kZSBjb21tIFRDUCBmcm9tIHdvcmtlcnMnKTtcbiAgICBtYW5hZ2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKHdvcmtlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnVkcCg3OTQ2KSwgJ05vZGUgY29tbSBVRFAgZnJvbSB3b3JrZXJzJyk7XG4gICAgLy8gT3ZlcmxheSBuZXR3b3JrIGZyb20gd29ya2Vyc1xuICAgIG1hbmFnZXJTZy5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5zZWN1cml0eUdyb3VwSWQod29ya2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudWRwKDQ3ODkpLCAnT3ZlcmxheSBuZXR3b3JrIGZyb20gd29ya2VycycpO1xuXG4gICAgLy8gLS0tIFdvcmtlciBpbmdyZXNzIHJ1bGVzIC0tLVxuICAgIHdvcmtlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLmFueUlwdjQoKSwgZWMyLlBvcnQudGNwKDIyKSwgJ1NTSCcpO1xuICAgIC8vIE5vZGUtdG8tbm9kZSBjb21tdW5pY2F0aW9uIGZyb20gbWFuYWdlclxuICAgIHdvcmtlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZChtYW5hZ2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudGNwKDc5NDYpLCAnTm9kZSBjb21tIFRDUCBmcm9tIG1hbmFnZXInKTtcbiAgICB3b3JrZXJTZy5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5zZWN1cml0eUdyb3VwSWQobWFuYWdlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnVkcCg3OTQ2KSwgJ05vZGUgY29tbSBVRFAgZnJvbSBtYW5hZ2VyJyk7XG4gICAgLy8gT3ZlcmxheSBuZXR3b3JrIGZyb20gbWFuYWdlclxuICAgIHdvcmtlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZChtYW5hZ2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudWRwKDQ3ODkpLCAnT3ZlcmxheSBuZXR3b3JrIGZyb20gbWFuYWdlcicpO1xuICAgIC8vIFdvcmtlci10by13b3JrZXIgY29tbXVuaWNhdGlvbiBmb3Igb3ZlcmxheSBuZXR3b3JraW5nXG4gICAgd29ya2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKHdvcmtlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnRjcCg3OTQ2KSwgJ05vZGUgY29tbSBUQ1AgYmV0d2VlbiB3b3JrZXJzJyk7XG4gICAgd29ya2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKHdvcmtlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnVkcCg3OTQ2KSwgJ05vZGUgY29tbSBVRFAgYmV0d2VlbiB3b3JrZXJzJyk7XG4gICAgd29ya2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKHdvcmtlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnVkcCg0Nzg5KSwgJ092ZXJsYXkgbmV0d29yayBiZXR3ZWVuIHdvcmtlcnMnKTtcblxuICAgIGNvbnN0IGluc3RhbmNlUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnRG9ja2VySW5zdGFuY2VSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2VjMi5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdBbWF6b25TU01NYW5hZ2VkSW5zdGFuY2VDb3JlJyksXG4gICAgICBdLFxuICAgIH0pO1xuICAgIGluc3RhbmNlUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ3NzbTpHZXRQYXJhbWV0ZXInLCAnc3NtOlB1dFBhcmFtZXRlciddLFxuICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgIGNkay5TdGFjay5vZih0aGlzKS5mb3JtYXRBcm4oe1xuICAgICAgICAgIHNlcnZpY2U6ICdzc20nLFxuICAgICAgICAgIHJlc291cmNlOiAncGFyYW1ldGVyJyxcbiAgICAgICAgICByZXNvdXJjZU5hbWU6IHdvcmtlckpvaW5Db21tYW5kUGFyYW1ldGVyTmFtZS5yZXBsYWNlKC9eXFwvLywgJycpLFxuICAgICAgICB9KSxcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgY29uc3QgYW1pID0gZWMyLk1hY2hpbmVJbWFnZS5nZW5lcmljTGludXgoe1xuICAgICAgW2Nkay5TdGFjay5vZih0aGlzKS5yZWdpb25dOiBwYXJhbXMuYW1pSWQsXG4gICAgfSk7XG4gICAgY29uc3QgaW5zdGFuY2VUeXBlID0gZWMyLkluc3RhbmNlVHlwZS5vZihlYzIuSW5zdGFuY2VDbGFzcy5DN0lfRkxFWCwgZWMyLkluc3RhbmNlU2l6ZS5MQVJHRSk7XG4gICAgY29uc3Qgc3NoS2V5UGFpciA9IG5ldyBlYzIuS2V5UGFpcih0aGlzLCAnRG9ja2VyU3NoS2V5UGFpcicsIHtcbiAgICAgIGtleVBhaXJOYW1lOiBzc2hLZXlOYW1lLFxuICAgICAgZm9ybWF0OiBlYzIuS2V5UGFpckZvcm1hdC5QRU0sXG4gICAgICB0eXBlOiBlYzIuS2V5UGFpclR5cGUuUlNBLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZG9ja2VyTWFuYWdlciA9IG5ldyBlYzIuSW5zdGFuY2UodGhpcywgJ0RvY2tlck1hbmFnZXInLCB7XG4gICAgICBpbnN0YW5jZU5hbWU6ICdkb2NrZXItc3dhcm0tbWFuYWdlcicsXG4gICAgICB2cGMsXG4gICAgICB2cGNTdWJuZXRzLFxuICAgICAgaW5zdGFuY2VUeXBlLFxuICAgICAgbWFjaGluZUltYWdlOiBhbWksXG4gICAgICBzZWN1cml0eUdyb3VwOiBtYW5hZ2VyU2csXG4gICAgICByb2xlOiBpbnN0YW5jZVJvbGUsXG4gICAgICBrZXlQYWlyOiBzc2hLZXlQYWlyLFxuICAgIH0pO1xuICAgIGRvY2tlck1hbmFnZXIubm9kZS5hZGREZXBlbmRlbmN5KHNzaEtleVBhaXIpO1xuICAgIGRvY2tlck1hbmFnZXIudXNlckRhdGEuYWRkQ29tbWFuZHMoXG4gICAgICAnc2V0IC1ldXhvIHBpcGVmYWlsJyxcbiAgICAgICdUT0tFTj0kKGN1cmwgLVggUFVUIFwiaHR0cDovLzE2OS4yNTQuMTY5LjI1NC9sYXRlc3QvYXBpL3Rva2VuXCIgLUggXCJYLWF3cy1lYzItbWV0YWRhdGEtdG9rZW4tdHRsLXNlY29uZHM6IDIxNjAwXCIpJyxcbiAgICAgICdQUklWQVRFX0lQPSQoY3VybCAtSCBcIlgtYXdzLWVjMi1tZXRhZGF0YS10b2tlbjogJFRPS0VOXCIgaHR0cDovLzE2OS4yNTQuMTY5LjI1NC9sYXRlc3QvbWV0YS1kYXRhL2xvY2FsLWlwdjQpJyxcbiAgICAgICdkb2NrZXIgaW5mbyAtLWZvcm1hdCBcInt7LlN3YXJtLkxvY2FsTm9kZVN0YXRlfX1cIiB8IGdyZXAgLXEgXCJeYWN0aXZlJFwiIHx8IGRvY2tlciBzd2FybSBpbml0IC0tYWR2ZXJ0aXNlLWFkZHIgXCIkUFJJVkFURV9JUFwiJyxcbiAgICAgICdKT0lOX1RPS0VOPSQoZG9ja2VyIHN3YXJtIGpvaW4tdG9rZW4gd29ya2VyIC1xKScsXG4gICAgICBgYXdzIHNzbSBwdXQtcGFyYW1ldGVyIC0tcmVnaW9uICR7Y2RrLlN0YWNrLm9mKHRoaXMpLnJlZ2lvbn0gLS1uYW1lIFwiJHt3b3JrZXJKb2luQ29tbWFuZFBhcmFtZXRlck5hbWV9XCIgLS10eXBlIFNlY3VyZVN0cmluZyAtLW92ZXJ3cml0ZSAtLXZhbHVlIFwiZG9ja2VyIHN3YXJtIGpvaW4gLS10b2tlbiAkSk9JTl9UT0tFTiAkUFJJVkFURV9JUDoyMzc3XCJgLFxuICAgICk7XG5cbiAgICBjb25zdCBkb2NrZXJXb3JrZXIgPSBuZXcgZWMyLkluc3RhbmNlKHRoaXMsICdEb2NrZXJXb3JrZXInLCB7XG4gICAgICBpbnN0YW5jZU5hbWU6ICdkb2NrZXItc3dhcm0td29ya2VyJyxcbiAgICAgIHZwYyxcbiAgICAgIHZwY1N1Ym5ldHMsXG4gICAgICBpbnN0YW5jZVR5cGUsXG4gICAgICBtYWNoaW5lSW1hZ2U6IGFtaSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IHdvcmtlclNnLFxuICAgICAgcm9sZTogaW5zdGFuY2VSb2xlLFxuICAgICAga2V5UGFpcjogc3NoS2V5UGFpcixcbiAgICB9KTtcbiAgICBkb2NrZXJXb3JrZXIubm9kZS5hZGREZXBlbmRlbmN5KHNzaEtleVBhaXIpO1xuICAgIGRvY2tlcldvcmtlci51c2VyRGF0YS5hZGRDb21tYW5kcyhcbiAgICAgICdzZXQgLWV1eG8gcGlwZWZhaWwnLFxuICAgICAgYGZvciBpIGluICQoc2VxIDEgNjApOyBkbyBKT0lOX0NPTU1BTkQ9JChhd3Mgc3NtIGdldC1wYXJhbWV0ZXIgLS1yZWdpb24gJHtjZGsuU3RhY2sub2YodGhpcykucmVnaW9ufSAtLW5hbWUgXCIke3dvcmtlckpvaW5Db21tYW5kUGFyYW1ldGVyTmFtZX1cIiAtLXdpdGgtZGVjcnlwdGlvbiAtLXF1ZXJ5IFBhcmFtZXRlci5WYWx1ZSAtLW91dHB1dCB0ZXh0IDI+L2Rldi9udWxsKSAmJiBicmVhazsgc2xlZXAgMTA7IGRvbmVgLFxuICAgICAgJ3Rlc3QgLW4gXCIke0pPSU5fQ09NTUFORDotfVwiJyxcbiAgICAgICdkb2NrZXIgaW5mbyAtLWZvcm1hdCBcInt7LlN3YXJtLkxvY2FsTm9kZVN0YXRlfX1cIiB8IGdyZXAgLXEgXCJeYWN0aXZlJFwiIHx8ICRKT0lOX0NPTU1BTkQnLFxuICAgICk7XG4gICAgZG9ja2VyV29ya2VyLm5vZGUuYWRkRGVwZW5kZW5jeShkb2NrZXJNYW5hZ2VyKTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEb2NrZXJNYW5hZ2VyUHJpdmF0ZUlwJywge1xuICAgICAgdmFsdWU6IGRvY2tlck1hbmFnZXIuaW5zdGFuY2VQcml2YXRlSXAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0RvY2tlciBTd2FybSBNYW5hZ2VyIHByaXZhdGUgSVAnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RvY2tlcldvcmtlclByaXZhdGVJcCcsIHtcbiAgICAgIHZhbHVlOiBkb2NrZXJXb3JrZXIuaW5zdGFuY2VQcml2YXRlSXAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0RvY2tlciBTd2FybSBXb3JrZXIgcHJpdmF0ZSBJUCcsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRG9ja2VyU3NoS2V5UGFpck5hbWUnLCB7XG4gICAgICB2YWx1ZTogc3NoS2V5UGFpci5rZXlQYWlyTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU1NIIGtleSBwYWlyIG5hbWUgZm9yIERvY2tlciBTd2FybSBFQzIgaW5zdGFuY2VzJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEb2NrZXJXb3JrZXJKb2luQ29tbWFuZFBhcmFtZXRlck5hbWUnLCB7XG4gICAgICB2YWx1ZTogd29ya2VySm9pbkNvbW1hbmRQYXJhbWV0ZXJOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdTU00gU2VjdXJlU3RyaW5nIHBhcmFtZXRlciBjb250YWluaW5nIHRoZSBEb2NrZXIgU3dhcm0gd29ya2VyIGpvaW4gY29tbWFuZCcsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==