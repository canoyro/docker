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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const params = JSON.parse(fs.readFileSync(path.join(__dirname, '../parameters.json'), 'utf-8'));
class DockerStack extends cdk.Stack {
    constructor(scope, id, props) {
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
exports.DockerStack = DockerStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZG9ja2VyLXByb2otc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJkb2NrZXItcHJvai1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxzREFBd0M7QUFDeEMseURBQTJDO0FBRTNDLHVDQUF5QjtBQUN6QiwyQ0FBNkI7QUFPN0IsTUFBTSxNQUFNLEdBQWlCLElBQUksQ0FBQyxLQUFLLENBQ3JDLEVBQUUsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsb0JBQW9CLENBQUMsRUFBRSxPQUFPLENBQUMsQ0FDckUsQ0FBQztBQUVGLE1BQWEsV0FBWSxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQ3hDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDOUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRSxFQUFFLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQztRQUUzRSxNQUFNLE1BQU0sR0FBRyxHQUFHLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUU5RSxNQUFNLFFBQVEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRTtZQUM1RCxHQUFHO1lBQ0gsaUJBQWlCLEVBQUUsaUJBQWlCO1lBQ3BDLFdBQVcsRUFBRSw2QkFBNkI7WUFDMUMsZ0JBQWdCLEVBQUUsSUFBSTtTQUN2QixDQUFDLENBQUM7UUFFSCxNQUFNO1FBQ04sUUFBUSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3JFLDBDQUEwQztRQUMxQyxRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxrQkFBa0IsQ0FBQyxDQUFDO1FBQ3BILDZCQUE2QjtRQUM3QixRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxlQUFlLENBQUMsQ0FBQztRQUNqSCxRQUFRLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQyxlQUFlLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxlQUFlLENBQUMsQ0FBQztRQUNqSCxrQkFBa0I7UUFDbEIsUUFBUSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxRQUFRLENBQUMsZUFBZSxDQUFDLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztRQUVuSCxNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMsWUFBWSxDQUFDLHFCQUFxQixFQUFFLENBQUM7UUFDckQsTUFBTSxZQUFZLEdBQUcsR0FBRyxDQUFDLFlBQVksQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxFQUFFLEVBQUUsR0FBRyxDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN2RixNQUFNLFVBQVUsR0FBRyxFQUFFLE9BQU8sRUFBRSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFFekMsTUFBTSxhQUFhLEdBQUcsSUFBSSxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUU7WUFDNUQsWUFBWSxFQUFFLHNCQUFzQjtZQUNwQyxHQUFHO1lBQ0gsVUFBVTtZQUNWLFlBQVk7WUFDWixZQUFZLEVBQUUsR0FBRztZQUNqQixhQUFhLEVBQUUsUUFBUTtZQUN2Qix3QkFBd0IsRUFBRSxJQUFJO1NBQy9CLENBQUMsQ0FBQztRQUVILE1BQU0sWUFBWSxHQUFHLElBQUksR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQzFELFlBQVksRUFBRSxxQkFBcUI7WUFDbkMsR0FBRztZQUNILFVBQVU7WUFDVixZQUFZO1lBQ1osWUFBWSxFQUFFLEdBQUc7WUFDakIsYUFBYSxFQUFFLFFBQVE7WUFDdkIsd0JBQXdCLEVBQUUsSUFBSTtTQUMvQixDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQ3pDLEtBQUssRUFBRSxhQUFhLENBQUMsZ0JBQWdCO1lBQ3JDLFdBQVcsRUFBRSxnQ0FBZ0M7U0FDOUMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUN4QyxLQUFLLEVBQUUsWUFBWSxDQUFDLGdCQUFnQjtZQUNwQyxXQUFXLEVBQUUsK0JBQStCO1NBQzdDLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQTNERCxrQ0EyREMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWIvY29yZSc7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5cbmludGVyZmFjZSBEb2NrZXJQYXJhbXMge1xuICB2cGNJZDogc3RyaW5nO1xuICBzdWJuZXRJZDogc3RyaW5nO1xufVxuXG5jb25zdCBwYXJhbXM6IERvY2tlclBhcmFtcyA9IEpTT04ucGFyc2UoXG4gIGZzLnJlYWRGaWxlU3luYyhwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vcGFyYW1ldGVycy5qc29uJyksICd1dGYtOCcpXG4pO1xuXG5leHBvcnQgY2xhc3MgRG9ja2VyU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCB2cGMgPSBlYzIuVnBjLmZyb21Mb29rdXAodGhpcywgJ0RvY2tlclZwYycsIHsgdnBjSWQ6IHBhcmFtcy52cGNJZCB9KTtcblxuICAgIGNvbnN0IHN1Ym5ldCA9IGVjMi5TdWJuZXQuZnJvbVN1Ym5ldElkKHRoaXMsICdEb2NrZXJTdWJuZXQnLCBwYXJhbXMuc3VibmV0SWQpO1xuXG4gICAgY29uc3QgZG9ja2VyU2cgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ0RvY2tlclN3YXJtU2cnLCB7XG4gICAgICB2cGMsXG4gICAgICBzZWN1cml0eUdyb3VwTmFtZTogJ2RvY2tlci1zd2FybS1zZycsXG4gICAgICBkZXNjcmlwdGlvbjogJ0RvY2tlciBTd2FybSBzZWN1cml0eSBncm91cCcsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgLy8gU1NIXG4gICAgZG9ja2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuYW55SXB2NCgpLCBlYzIuUG9ydC50Y3AoMjIpLCAnU1NIJyk7XG4gICAgLy8gU3dhcm0gY2x1c3RlciBtYW5hZ2VtZW50IChtYW5hZ2VyIG9ubHkpXG4gICAgZG9ja2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKGRvY2tlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnRjcCgyMzc3KSwgJ1N3YXJtIG1hbmFnZW1lbnQnKTtcbiAgICAvLyBOb2RlLXRvLW5vZGUgY29tbXVuaWNhdGlvblxuICAgIGRvY2tlclNnLmFkZEluZ3Jlc3NSdWxlKGVjMi5QZWVyLnNlY3VyaXR5R3JvdXBJZChkb2NrZXJTZy5zZWN1cml0eUdyb3VwSWQpLCBlYzIuUG9ydC50Y3AoNzk0NiksICdOb2RlIGNvbW0gVENQJyk7XG4gICAgZG9ja2VyU2cuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuc2VjdXJpdHlHcm91cElkKGRvY2tlclNnLnNlY3VyaXR5R3JvdXBJZCksIGVjMi5Qb3J0LnVkcCg3OTQ2KSwgJ05vZGUgY29tbSBVRFAnKTtcbiAgICAvLyBPdmVybGF5IG5ldHdvcmtcbiAgICBkb2NrZXJTZy5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5zZWN1cml0eUdyb3VwSWQoZG9ja2VyU2cuc2VjdXJpdHlHcm91cElkKSwgZWMyLlBvcnQudWRwKDQ3ODkpLCAnT3ZlcmxheSBuZXR3b3JrJyk7XG5cbiAgICBjb25zdCBhbWkgPSBlYzIuTWFjaGluZUltYWdlLmxhdGVzdEFtYXpvbkxpbnV4MjAyMygpO1xuICAgIGNvbnN0IGluc3RhbmNlVHlwZSA9IGVjMi5JbnN0YW5jZVR5cGUub2YoZWMyLkluc3RhbmNlQ2xhc3MuVDMsIGVjMi5JbnN0YW5jZVNpemUuTUlDUk8pO1xuICAgIGNvbnN0IHZwY1N1Ym5ldHMgPSB7IHN1Ym5ldHM6IFtzdWJuZXRdIH07XG5cbiAgICBjb25zdCBkb2NrZXJNYW5hZ2VyID0gbmV3IGVjMi5JbnN0YW5jZSh0aGlzLCAnRG9ja2VyTWFuYWdlcicsIHtcbiAgICAgIGluc3RhbmNlTmFtZTogJ2RvY2tlci1zd2FybS1tYW5hZ2VyJyxcbiAgICAgIHZwYyxcbiAgICAgIHZwY1N1Ym5ldHMsXG4gICAgICBpbnN0YW5jZVR5cGUsXG4gICAgICBtYWNoaW5lSW1hZ2U6IGFtaSxcbiAgICAgIHNlY3VyaXR5R3JvdXA6IGRvY2tlclNnLFxuICAgICAgYXNzb2NpYXRlUHVibGljSXBBZGRyZXNzOiB0cnVlLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZG9ja2VyV29ya2VyID0gbmV3IGVjMi5JbnN0YW5jZSh0aGlzLCAnRG9ja2VyV29ya2VyJywge1xuICAgICAgaW5zdGFuY2VOYW1lOiAnZG9ja2VyLXN3YXJtLXdvcmtlcicsXG4gICAgICB2cGMsXG4gICAgICB2cGNTdWJuZXRzLFxuICAgICAgaW5zdGFuY2VUeXBlLFxuICAgICAgbWFjaGluZUltYWdlOiBhbWksXG4gICAgICBzZWN1cml0eUdyb3VwOiBkb2NrZXJTZyxcbiAgICAgIGFzc29jaWF0ZVB1YmxpY0lwQWRkcmVzczogdHJ1ZSxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdEb2NrZXJNYW5hZ2VySXAnLCB7XG4gICAgICB2YWx1ZTogZG9ja2VyTWFuYWdlci5pbnN0YW5jZVB1YmxpY0lwLFxuICAgICAgZGVzY3JpcHRpb246ICdEb2NrZXIgU3dhcm0gTWFuYWdlciBwdWJsaWMgSVAnLFxuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RvY2tlcldvcmtlcklwJywge1xuICAgICAgdmFsdWU6IGRvY2tlcldvcmtlci5pbnN0YW5jZVB1YmxpY0lwLFxuICAgICAgZGVzY3JpcHRpb246ICdEb2NrZXIgU3dhcm0gV29ya2VyIHB1YmxpYyBJUCcsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==