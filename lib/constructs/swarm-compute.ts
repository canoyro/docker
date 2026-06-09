import * as cdk from 'aws-cdk-lib/core';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

interface SwarmComputeProps {
  vpc: ec2.IVpc;
  vpcSubnets: ec2.SubnetSelection;
  managerSg: ec2.SecurityGroup;
  workerSg: ec2.SecurityGroup;
  instanceType: string;
  amiId: string;
}

export class SwarmCompute extends Construct {
  readonly managerAsgName: string;
  readonly workerAsgName: string;
  readonly sshKeyPairName: string;
  readonly internalApiRepositoryUri: string;
  readonly sharedStorageBucketName: string;

  constructor(scope: Construct, id: string, props: SwarmComputeProps) {
    super(scope, id);

    const { vpc, vpcSubnets, managerSg, workerSg } = props;
    const stackName = cdk.Stack.of(this).stackName;
    const region = cdk.Stack.of(this).region;

    const bootstrapManagerIpParam = `/docker-swarm/${stackName}/bootstrap-manager-ip`;
    const managerJoinCommandParam = `/docker-swarm/${stackName}/manager-join-command`;
    const workerJoinCommandParam = `/docker-swarm/${stackName}/worker-join-command`;

    const bucket = new s3.Bucket(this, 'DockerSharedStorageBucket', {
      bucketName: `${stackName.toLowerCase()}-shared-storage`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });
    this.sharedStorageBucketName = bucket.bucketName;

    const ssmParamArn = cdk.Stack.of(this).formatArn({ service: 'ssm', resource: 'parameter', resourceName: `docker-swarm/${stackName}/*` });
    const ecrRepoArn = cdk.Stack.of(this).formatArn({ service: 'ecr', resource: 'repository', resourceName: '*' });
    const ssmCore = iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore');

    const addSharedPolicies = (role: iam.Role) => {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [ecrRepoArn],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['autoscaling:SetInstanceHealth'],
        resources: ['*'],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:HeadObject'],
        resources: [`${bucket.bucketArn}/*`],
      }));
    };

    const managerRole = new iam.Role(this, 'DockerManagerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [ssmCore],
    });
    managerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
      resources: [ssmParamArn],
    }));
    addSharedPolicies(managerRole);

    const workerRole = new iam.Role(this, 'DockerWorkerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [ssmCore],
    });
    workerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [ssmParamArn],
    }));
    addSharedPolicies(workerRole);

    const ami = ec2.MachineImage.genericLinux({ [region]: props.amiId });
    const instanceTypeObj = new ec2.InstanceType(props.instanceType);

    const sshKeyPair = new ec2.KeyPair(this, 'DockerSshKeyPair', {
      keyPairName: `${stackName.toLowerCase()}-ssh-key`,
      format: ec2.KeyPairFormat.PEM,
      type: ec2.KeyPairType.RSA,
    });
    this.sshKeyPairName = sshKeyPair.keyPairName;

    const internalApiRepository = new ecr.Repository(this, 'DockerInternalApiRepository', {
      repositoryName: 'internal-file-api',
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ description: 'Expire untagged images after 7 days', tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: cdk.Duration.days(7) }],
    });
    this.internalApiRepositoryUri = internalApiRepository.repositoryUri;

    const loadScript = (filename: string, subs: Record<string, string> = {}): string => {
      let content = fs.readFileSync(path.join(__dirname, '../user-data', filename), 'utf-8');
      for (const [placeholder, value] of Object.entries(subs)) {
        content = content.replace(new RegExp(placeholder, 'g'), value);
      }
      return content;
    };

    const paramSubs = {
      __REGION__: region,
      __BOOTSTRAP_MANAGER_IP_PARAM__: bootstrapManagerIpParam,
      __MANAGER_JOIN_COMMAND_PARAM__: managerJoinCommandParam,
      __WORKER_JOIN_COMMAND_PARAM__: workerJoinCommandParam,
    };

    const s3Subs = { __S3_BUCKET_NAME__: bucket.bucketName };

    const addSystemdScript = (
      userData: ec2.UserData,
      scriptPath: string,
      scriptContent: string,
      serviceName: string,
      serviceDescription: string,
      envVars: Record<string, string>,
      onBootSec: string,
    ) => {
      userData.addCommands(
        `cat > ${scriptPath} <<'SCRIPTEOF'`,
        scriptContent,
        `SCRIPTEOF`,
        `chmod +x ${scriptPath}`,
        `cat > /etc/systemd/system/${serviceName}.service <<EOF`,
        `[Unit]`,
        `Description=${serviceDescription}`,
        ``,
        `[Service]`,
        `Type=oneshot`,
        ...Object.entries(envVars).map(([k, v]) => `Environment=${k}=${v}`),
        `ExecStart=${scriptPath}`,
        `EOF`,
        `cat > /etc/systemd/system/${serviceName}.timer <<'TIMEREOF'`,
        `[Unit]`,
        `Description=Run ${serviceDescription}`,
        ``,
        `[Timer]`,
        `OnBootSec=${onBootSec}`,
        `OnUnitActiveSec=1min`,
        `Unit=${serviceName}.service`,
        ``,
        `[Install]`,
        `WantedBy=timers.target`,
        `TIMEREOF`,
        `systemctl daemon-reload`,
        `systemctl enable --now ${serviceName}.timer`,
      );
    };

    // Manager user data
    const managerUserData = ec2.UserData.forLinux();
    managerUserData.addCommands(loadScript('manager-init.sh', paramSubs));
    managerUserData.addCommands(loadScript('s3-mount.sh', s3Subs));
    addSystemdScript(
      managerUserData,
      '/usr/local/bin/docker-manager-ssm-refresh.sh',
      loadScript('ssm-refresh.sh', paramSubs),
      'docker-manager-ssm-refresh',
      'Publish Docker Swarm manager join parameters to SSM',
      { AWS_REGION: region },
      '1min',
    );
    managerUserData.addCommands('/usr/local/bin/docker-manager-ssm-refresh.sh || true');
    addSystemdScript(
      managerUserData,
      '/usr/local/bin/docker-asg-healthcheck.sh',
      loadScript('health-check.sh'),
      'docker-asg-healthcheck',
      'Report unhealthy Docker instances to Auto Scaling',
      { AWS_REGION: region },
      '5min',
    );

    // Worker user data
    const workerUserData = ec2.UserData.forLinux();
    workerUserData.addCommands(loadScript('worker-init.sh', paramSubs));
    workerUserData.addCommands(loadScript('s3-mount.sh', s3Subs));
    addSystemdScript(
      workerUserData,
      '/usr/local/bin/docker-asg-healthcheck.sh',
      loadScript('health-check.sh'),
      'docker-asg-healthcheck',
      'Report unhealthy Docker instances to Auto Scaling',
      { AWS_REGION: region },
      '5min',
    );

    const managerAsg = new autoscaling.AutoScalingGroup(this, 'DockerManagerAsg', {
      vpc,
      vpcSubnets,
      instanceType: instanceTypeObj,
      machineImage: ami,
      securityGroup: managerSg,
      role: managerRole,
      keyPair: sshKeyPair,
      userData: managerUserData,
      minCapacity: 1,
      maxCapacity: 1,
      healthChecks: autoscaling.HealthChecks.ec2({ gracePeriod: cdk.Duration.minutes(5) }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({ maxBatchSize: 1, minInstancesInService: 2, waitOnResourceSignals: false }),
    });
    managerAsg.node.addDependency(sshKeyPair);
    managerAsg.scaleOnCpuUtilization('DockerManagerCpuScaling', { targetUtilizationPercent: 60, cooldown: cdk.Duration.minutes(5) });
    cdk.Tags.of(managerAsg).add('Name', 'docker-swarm-manager');
    this.managerAsgName = managerAsg.autoScalingGroupName;

    const workerAsg = new autoscaling.AutoScalingGroup(this, 'DockerWorkerAsg', {
      vpc,
      vpcSubnets,
      instanceType: instanceTypeObj,
      machineImage: ami,
      securityGroup: workerSg,
      role: workerRole,
      keyPair: sshKeyPair,
      userData: workerUserData,
      minCapacity: 1,
      maxCapacity: 4,
      healthChecks: autoscaling.HealthChecks.ec2({ gracePeriod: cdk.Duration.minutes(5) }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({ maxBatchSize: 1, minInstancesInService: 1, waitOnResourceSignals: false }),
    });
    workerAsg.node.addDependency(sshKeyPair);
    workerAsg.node.addDependency(managerAsg);
    workerAsg.scaleOnCpuUtilization('DockerWorkerCpuScaling', { targetUtilizationPercent: 40, cooldown: cdk.Duration.minutes(5) });
    cdk.Tags.of(workerAsg).add('Name', 'docker-swarm-worker');
    this.workerAsgName = workerAsg.autoScalingGroupName;
  }
}
