import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import { cloudWanTagKey } from '../network-config';

export interface BoundaryVpcProps {
  /** VPC CIDR ブロック */
  readonly vpcCidr: string;
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN */
  readonly coreNetworkArn: string;
  /** Cloud WAN セグメント タグ値 */
  readonly cloudWanSegmentTag: string;
}

export class BoundaryVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: BoundaryVpcProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const az = cdk.Fn.select(0, cdk.Fn.getAzs());

    // VPC
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      enableDnsSupport: true,
      enableDnsHostnames: true,
      subnetConfiguration: [],
      natGateways: 0,
    });
    this.vpc = vpc;

    // Subnets
    const natSubnet = new ec2.CfnSubnet(this, 'NatSubnet', {
      vpcId: vpc.vpcId,
      cidrBlock: cdk.Fn.select(0, cdk.Fn.cidr(props.vpcCidr, 11, '8')),
      availabilityZone: az,
      tags: [{ key: 'Name', value: `${stack.stackName}-BoundaryVpc-NatSubnet` }],
    });

    const attSubnet = new ec2.CfnSubnet(this, 'AttSubnet', {
      vpcId: vpc.vpcId,
      cidrBlock: cdk.Fn.select(10, cdk.Fn.cidr(props.vpcCidr, 11, '8')),
      availabilityZone: az,
      tags: [{ key: 'Name', value: `${stack.stackName}-BoundaryVpc-AttSubnet` }],
    });

    // Internet Gateway
    const igw = new ec2.CfnInternetGateway(this, 'Igw', {});
    new ec2.CfnVPCGatewayAttachment(this, 'IgwAttach', {
      internetGatewayId: igw.ref,
      vpcId: vpc.vpcId,
    });

    // NAT Gateway
    const natEip = new ec2.CfnEIP(this, 'NatEip', { domain: 'vpc' });
    const natGw = new ec2.CfnNatGateway(this, 'NatGw', {
      subnetId: natSubnet.ref,
      allocationId: natEip.attrAllocationId,
    });

    // Route Tables
    const natSubnetRtb = new ec2.CfnRouteTable(this, 'NatSubnetRtb', {
      vpcId: vpc.vpcId,
      tags: [{ key: 'Name', value: `${stack.stackName}-BoundaryVpc-NatSubnetRtb` }],
    });

    const attSubnetRtb = new ec2.CfnRouteTable(this, 'AttSubnetRtb', {
      vpcId: vpc.vpcId,
      tags: [{ key: 'Name', value: `${stack.stackName}-BoundaryVpc-AttSubnetRtb` }],
    });

    // Route Table Associations
    new ec2.CfnSubnetRouteTableAssociation(this, 'NatSubnetRtbAssoc', {
      subnetId: natSubnet.ref,
      routeTableId: natSubnetRtb.ref,
    });

    new ec2.CfnSubnetRouteTableAssociation(this, 'AttSubnetRtbAssoc', {
      subnetId: attSubnet.ref,
      routeTableId: attSubnetRtb.ref,
    });

    // Routes - NAT Subnet
    new ec2.CfnRoute(this, 'NatSubnetDefaultRoute', {
      routeTableId: natSubnetRtb.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: igw.ref,
    });

    // Routes - ATT Subnet
    new ec2.CfnRoute(this, 'AttSubnetDefaultRoute', {
      routeTableId: attSubnetRtb.ref,
      destinationCidrBlock: '0.0.0.0/0',
      natGatewayId: natGw.ref,
    });

    // Cloud WAN VPC Attachment
    const attachment = new networkmanager.CfnVpcAttachment(this, 'CloudWanAttachment', {
      coreNetworkId: props.coreNetworkId,
      vpcArn: vpc.vpcArn,
      subnetArns: [
        cdk.Arn.format({
          service: 'ec2',
          resource: 'subnet',
          resourceName: attSubnet.ref,
        }, stack),
      ],
      tags: [{ key: cloudWanTagKey.Segment, value: props.cloudWanSegmentTag }],
    });

    // Core Network Route (NAT Subnet - return traffic to Cloud WAN)
    const coreNetworkRoute = new ec2.CfnRoute(this, 'NatSubnetCoreNetworkRoute', {
      routeTableId: natSubnetRtb.ref,
      destinationCidrBlock: '10.0.0.0/8',
      coreNetworkArn: props.coreNetworkArn,
    });
    coreNetworkRoute.addDependency(attachment);
  }
}
