import * as cdk from "aws-cdk-lib/core";

import { Construct } from "constructs";
import {
  CoreNetwork,
  EgressVpc,
  PrivateVpc,
  InspectionVpc,
} from "./constructs";
import {
  REGION1_NETWORK,
  cloudWanSegment,
  cloudWanNfg,
} from "./network-config";

export interface Region1StackProps extends cdk.StackProps {
  readonly region2: string;
}

export class Region1Stack extends cdk.Stack {
  public readonly coreNetworkId: string;
  public readonly coreNetworkArn: string;

  constructor(scope: Construct, id: string, props: Region1StackProps) {
    super(scope, id, props);

    // Core Network
    const coreNetwork = new CoreNetwork(this, "CoreNetwork", {
      region1: this.region,
      region2: props.region2,
    });
    this.coreNetworkId = coreNetwork.coreNetworkId;
    this.coreNetworkArn = coreNetwork.coreNetworkArn;

    // Egress VPC
    new EgressVpc(this, "EgressVpc", {
      vpcCidr: REGION1_NETWORK.egress.vpcCidr,
      coreNetworkId: coreNetwork.coreNetworkId,
      coreNetworkArn: coreNetwork.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Share,
    });

    // Prod Private VPC
    new PrivateVpc(this, "ProdPrivateVpc", {
      vpcCidr: REGION1_NETWORK.prodPrivate.vpcCidr,
      coreNetworkId: coreNetwork.coreNetworkId,
      coreNetworkArn: coreNetwork.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Prod,
    });

    // Dev Private VPC
    new PrivateVpc(this, "DevPrivateVpc", {
      vpcCidr: REGION1_NETWORK.devPrivate!.vpcCidr,
      coreNetworkId: coreNetwork.coreNetworkId,
      coreNetworkArn: coreNetwork.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Dev,
    });

    // Inspection VPC
    new InspectionVpc(this, "InspectionVpc", {
      vpcCidr: REGION1_NETWORK.inspection!.vpcCidr,
      coreNetworkId: coreNetwork.coreNetworkId,
      coreNetworkArn: coreNetwork.coreNetworkArn,
      cloudWanNfgTag: cloudWanNfg.Security,
    });
  }
}
