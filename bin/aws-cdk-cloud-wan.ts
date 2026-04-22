#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Region1Stack } from '../lib/region1-stack';
import { Region2Stack } from '../lib/region2-stack';

const app = new cdk.App();

const region1 = 'ap-northeast-1';
const region2 = 'us-east-1';

const region1Stack = new Region1Stack(app, 'CloudWanRegion1Stack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: region1 },
  region2,
  crossRegionReferences: true,
});

const region2Stack = new Region2Stack(app, 'CloudWanRegion2Stack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: region2 },
  coreNetworkId: region1Stack.coreNetworkId,
  coreNetworkArn: region1Stack.coreNetworkArn,
  crossRegionReferences: true,
});

region2Stack.addDependency(region1Stack);
