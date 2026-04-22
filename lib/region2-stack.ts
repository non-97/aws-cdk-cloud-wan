import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { BoundaryVpc, PrivateVpc, VpnVpc } from "./constructs";
import { REGION2_NETWORK, cloudWanSegment } from "./network-config";

export interface Region2StackProps extends cdk.StackProps {
  readonly coreNetworkId: string;
  readonly coreNetworkArn: string;
}

export class Region2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Region2StackProps) {
    super(scope, id, props);

    // IAM Role + Instance Profile
    const ec2Role = new iam.Role(this, "Ec2Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess"),
      ],
    });

    const instanceProfile = new iam.CfnInstanceProfile(
      this,
      "InstanceProfile",
      {
        roles: [ec2Role.roleName],
      }
    );

    // Boundary VPC
    new BoundaryVpc(this, "BoundaryVpc", {
      vpcCidr: REGION2_NETWORK.boundary.vpcCidr,
      coreNetworkId: props.coreNetworkId,
      coreNetworkArn: props.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Share,
    });

    // Private VPC
    new PrivateVpc(this, "PrivateVpc", {
      vpcCidr: REGION2_NETWORK.private.vpcCidr,
      coreNetworkId: props.coreNetworkId,
      coreNetworkArn: props.coreNetworkArn,
      cloudWanSegmentTag: cloudWanSegment.Prod,
      instanceProfileArn: instanceProfile.ref,
      ec2PrivateIp: REGION2_NETWORK.private.ec2PrivateIp!,
    });

    // VPN VPC
    new VpnVpc(this, "VpnVpc", {
      vpcCidr: REGION2_NETWORK.vpn!.vpcCidr,
      coreNetworkId: props.coreNetworkId,
      cloudWanSegmentTag: cloudWanSegment.Dev,
      instanceProfileArn: instanceProfile.ref,
    });
  }
}
