#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { DockerStack } from '../lib/docker-proj-stack';

const app = new cdk.App();
new DockerStack(app, 'DockerStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
