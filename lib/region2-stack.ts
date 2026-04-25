import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';
import { EgressVpc, PrivateVpc, VpnVpc } from './constructs';
import { REGION2_NETWORK, cloudWanSegment } from './network-config';

export interface Region2StackProps extends cdk.StackProps {
  readonly coreNetworkId: string;
  readonly coreNetworkArn: string;
}

export class Region2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Region2StackProps) {
    super(scope, id, props);

    // Egress VPC
    new EgressVpc(this, 'EgressVpc', {
      vpcCidr: REGION2_NETWORK.egress.vpcCidr,
      coreNetworkId: props.coreNetworkId,
      coreNetworkArn: props.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Share,
    });

    // Prod Private VPC
    new PrivateVpc(this, 'ProdPrivateVpc', {
      vpcCidr: REGION2_NETWORK.prodPrivate.vpcCidr,
      coreNetworkId: props.coreNetworkId,
      coreNetworkArn: props.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Prod,
    });

    // VPN VPC
    new VpnVpc(this, 'VpnVpc', {
      vpcCidr: REGION2_NETWORK.vpn!.vpcCidr,
      coreNetworkId: props.coreNetworkId,
      cloudWanSegmentTag: cloudWanSegment.Dev,
    });
  }
}
