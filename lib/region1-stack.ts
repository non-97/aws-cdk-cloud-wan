import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { CoreNetwork, BoundaryVpc, PrivateVpc, SecurityVpc } from './constructs';
import { REGION1_NETWORK, cloudWanSegment, cloudWanNfg } from './network-config';

export interface Region1StackProps extends cdk.StackProps {
  readonly region2: string;
}

export class Region1Stack extends cdk.Stack {
  public readonly coreNetworkId: string;
  public readonly coreNetworkArn: string;

  constructor(scope: Construct, id: string, props: Region1StackProps) {
    super(scope, id, props);

    // Core Network
    const coreNetwork = new CoreNetwork(this, 'CoreNetwork', {
      region1: this.region,
      region2: props.region2,
    });
    this.coreNetworkId = coreNetwork.coreNetworkId;
    this.coreNetworkArn = coreNetwork.coreNetworkArn;

    // IAM Role + Instance Profile
    const ec2Role = new iam.Role(this, 'Ec2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
      ],
    });

    const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
      roles: [ec2Role.roleName],
    });

    // Boundary VPC
    new BoundaryVpc(this, 'BoundaryVpc', {
      vpcCidr: REGION1_NETWORK.boundary.vpcCidr,
      coreNetworkId: coreNetwork.coreNetworkId,
      coreNetworkArn: coreNetwork.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Share,
    });

    // Private VPC
    new PrivateVpc(this, 'PrivateVpc', {
      vpcCidr: REGION1_NETWORK.private.vpcCidr,
      coreNetworkId: coreNetwork.coreNetworkId,
      coreNetworkArn: coreNetwork.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Prod,
      instanceProfileArn: instanceProfile.ref,
      ec2PrivateIp: REGION1_NETWORK.private.ec2PrivateIp!,
    });

    // Security VPC
    new SecurityVpc(this, 'SecurityVpc', {
      vpcCidr: REGION1_NETWORK.security!.vpcCidr,
      coreNetworkId: coreNetwork.coreNetworkId,
      coreNetworkArn: coreNetwork.coreNetworkArn,
      cloudWanNfgTag: cloudWanNfg.Security,
    });
  }
}
