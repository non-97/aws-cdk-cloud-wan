import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import { RFC1918_CIDRS, cloudWanTagKey } from '../network-config';

export interface PrivateVpcProps {
  /** VPC CIDR ブロック */
  readonly vpcCidr: string;
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN */
  readonly coreNetworkArn: string;
  /** Cloud WAN セグメント タグ値 */
  readonly cloudWanSegmentTag: string;
  /** EC2 インスタンスプロファイル ARN */
  readonly instanceProfileArn: string;
  /** EC2 のプライベート IP アドレス */
  readonly ec2PrivateIp: string;
}

export class PrivateVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: PrivateVpcProps) {
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
    const privateSubnet = new ec2.CfnSubnet(this, 'PrivateSubnet', {
      vpcId: vpc.vpcId,
      cidrBlock: cdk.Fn.select(1, cdk.Fn.cidr(props.vpcCidr, 11, '8')),
      availabilityZone: az,
      tags: [{ key: 'Name', value: `${stack.stackName}-PrivateVpc-PrivateSubnet` }],
    });

    const attSubnet = new ec2.CfnSubnet(this, 'AttSubnet', {
      vpcId: vpc.vpcId,
      cidrBlock: cdk.Fn.select(10, cdk.Fn.cidr(props.vpcCidr, 11, '8')),
      availabilityZone: az,
      tags: [{ key: 'Name', value: `${stack.stackName}-PrivateVpc-AttSubnet` }],
    });

    // Route Tables
    const privateSubnetRtb = new ec2.CfnRouteTable(this, 'PrivateSubnetRtb', {
      vpcId: vpc.vpcId,
      tags: [{ key: 'Name', value: `${stack.stackName}-PrivateVpc-PrivateSubnetRtb` }],
    });

    const attSubnetRtb = new ec2.CfnRouteTable(this, 'AttSubnetRtb', {
      vpcId: vpc.vpcId,
      tags: [{ key: 'Name', value: `${stack.stackName}-PrivateVpc-AttSubnetRtb` }],
    });

    // Route Table Associations
    new ec2.CfnSubnetRouteTableAssociation(this, 'PrivateSubnetRtbAssoc', {
      subnetId: privateSubnet.ref,
      routeTableId: privateSubnetRtb.ref,
    });

    new ec2.CfnSubnetRouteTableAssociation(this, 'AttSubnetRtbAssoc', {
      subnetId: attSubnet.ref,
      routeTableId: attSubnetRtb.ref,
    });

    // Security Group for EC2
    const ec2Sg = new ec2.CfnSecurityGroup(this, 'Ec2Sg', {
      groupDescription: 'for EC2 instance',
      vpcId: vpc.vpcId,
      securityGroupIngress: RFC1918_CIDRS.map((cidr) => ({
        ipProtocol: '-1',
        fromPort: -1,
        toPort: -1,
        cidrIp: cidr,
      })),
      tags: [{ key: 'Name', value: `${stack.stackName}-PrivateVpc-Ec2Sg` }],
    });

    // EC2 Instance (AMI resolved at deploy time via SSM parameter)
    const al2023AmiId = ssm.StringParameter.valueForStringParameter(
      this,
      '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
    );
    new ec2.CfnInstance(this, 'Instance', {
      imageId: al2023AmiId,
      instanceType: 't3.micro',
      iamInstanceProfile: props.instanceProfileArn,
      networkInterfaces: [
        {
          deviceIndex: '0',
          subnetId: privateSubnet.ref,
          groupSet: [ec2Sg.attrGroupId],
          privateIpAddresses: [
            { privateIpAddress: props.ec2PrivateIp, primary: true },
          ],
        },
      ],
      tags: [{ key: 'Name', value: `${stack.stackName}-PrivateVpc-Instance` }],
    });

    // EIC Endpoint
    const eicSg = new ec2.CfnSecurityGroup(this, 'EicSg', {
      groupDescription: 'for EIC Endpoint',
      vpcId: vpc.vpcId,
      securityGroupEgress: [
        { ipProtocol: 'tcp', fromPort: 22, toPort: 22, cidrIp: props.vpcCidr },
      ],
      tags: [{ key: 'Name', value: `${stack.stackName}-PrivateVpc-EicSg` }],
    });

    new ec2.CfnInstanceConnectEndpoint(this, 'EicEndpoint', {
      subnetId: privateSubnet.ref,
      securityGroupIds: [eicSg.attrGroupId],
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

    // Core Network Route (Private Subnet - all traffic via Cloud WAN)
    const coreNetworkRoute = new ec2.CfnRoute(this, 'PrivateSubnetDefaultRoute', {
      routeTableId: privateSubnetRtb.ref,
      destinationCidrBlock: '0.0.0.0/0',
      coreNetworkArn: props.coreNetworkArn,
    });
    coreNetworkRoute.addDependency(attachment);
  }
}
