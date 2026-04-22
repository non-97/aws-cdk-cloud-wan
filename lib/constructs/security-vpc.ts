import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as networkfirewall from 'aws-cdk-lib/aws-networkfirewall';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import { ALL_VPC_CIDRS, cloudWanTagKey } from '../network-config';

export interface SecurityVpcProps {
  /** VPC CIDR ブロック */
  readonly vpcCidr: string;
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN */
  readonly coreNetworkArn: string;
  /** Cloud WAN Network Function Group タグ値 */
  readonly cloudWanNfgTag: string;
}

/**
 * Security VPC - Network Firewall による検査専用。
 * send-via (single-hop) モードで使用するため、インターネット出口(IGW/NAT)は不要。
 * 検査後のトラフィックは Core Network 経由で最終宛先に転送される。
 */
export class SecurityVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: SecurityVpcProps) {
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

    // Subnets (NAT Subnet不要 - send-viaモードではインターネット出口はBoundary VPCが担当)
    const fwSubnet = new ec2.CfnSubnet(this, 'FwSubnet', {
      vpcId: vpc.vpcId,
      cidrBlock: cdk.Fn.select(1, cdk.Fn.cidr(props.vpcCidr, 11, '8')),
      availabilityZone: az,
      tags: [{ key: 'Name', value: `${stack.stackName}-SecurityVpc-FwSubnet` }],
    });

    const attSubnet = new ec2.CfnSubnet(this, 'AttSubnet', {
      vpcId: vpc.vpcId,
      cidrBlock: cdk.Fn.select(10, cdk.Fn.cidr(props.vpcCidr, 11, '8')),
      availabilityZone: az,
      tags: [{ key: 'Name', value: `${stack.stackName}-SecurityVpc-AttSubnet` }],
    });

    // Route Tables
    const fwSubnetRtb = new ec2.CfnRouteTable(this, 'FwSubnetRtb', {
      vpcId: vpc.vpcId,
      tags: [{ key: 'Name', value: `${stack.stackName}-SecurityVpc-FwSubnetRtb` }],
    });

    const attSubnetRtb = new ec2.CfnRouteTable(this, 'AttSubnetRtb', {
      vpcId: vpc.vpcId,
      tags: [{ key: 'Name', value: `${stack.stackName}-SecurityVpc-AttSubnetRtb` }],
    });

    // Route Table Associations
    new ec2.CfnSubnetRouteTableAssociation(this, 'FwSubnetRtbAssoc', {
      subnetId: fwSubnet.ref,
      routeTableId: fwSubnetRtb.ref,
    });

    new ec2.CfnSubnetRouteTableAssociation(this, 'AttSubnetRtbAssoc', {
      subnetId: attSubnet.ref,
      routeTableId: attSubnetRtb.ref,
    });

    // Network Firewall Rule Group
    // NOTE: ruleGroupName/firewallPolicyName/firewallName は CFn L1 必須プロパティ
    const nfwRuleGroup = new networkfirewall.CfnRuleGroup(this, 'NfwRuleGroup', {
      ruleGroupName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + '-RuleGroup',
      capacity: 1000,
      type: 'STATEFUL',
      ruleGroup: {
        statefulRuleOptions: {
          ruleOrder: 'STRICT_ORDER',
        },
        ruleVariables: {
          ipSets: Object.fromEntries(
            Object.entries(ALL_VPC_CIDRS).map(([key, cidrs]) => [
              key,
              { definition: [...cidrs] },
            ]),
          ),
        },
        rulesSource: {
          rulesString: 'pass ip $Region1_PrivateVPC_NET any -> any any (sid:1000001; rev:1;)\n',
        },
      },
    });

    // Network Firewall Policy
    const nfwPolicy = new networkfirewall.CfnFirewallPolicy(this, 'NfwPolicy', {
      firewallPolicyName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + '-Policy',
      firewallPolicy: {
        statelessDefaultActions: ['aws:forward_to_sfe'],
        statelessFragmentDefaultActions: ['aws:forward_to_sfe'],
        statefulDefaultActions: ['aws:drop_established'],
        statefulEngineOptions: {
          ruleOrder: 'STRICT_ORDER',
        },
        statefulRuleGroupReferences: [
          {
            priority: 1,
            resourceArn: nfwRuleGroup.ref,
          },
        ],
      },
    });

    // Network Firewall
    const nfw = new networkfirewall.CfnFirewall(this, 'Nfw', {
      firewallName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + '-Nfw',
      firewallPolicyArn: nfwPolicy.ref,
      subnetMappings: [{ subnetId: fwSubnet.ref }],
      vpcId: vpc.vpcId,
    });

    // Extract NFW VPC Endpoint ID
    // EndpointIds returns ["az:vpce-xxx"] for single-AZ
    const fwEndpointId = cdk.Fn.select(
      1,
      cdk.Fn.split(':', cdk.Fn.join(',', nfw.attrEndpointIds)),
    );

    // Routes - ATT Subnet: Cloud WANからのトラフィックをNFWへ
    new ec2.CfnRoute(this, 'AttSubnetDefaultRoute', {
      routeTableId: attSubnetRtb.ref,
      destinationCidrBlock: '0.0.0.0/0',
      vpcEndpointId: fwEndpointId,
    });

    // Cloud WAN VPC Attachment (NFG: security, Appliance Mode有効)
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
      options: {
        applianceModeSupport: true,
      },
      tags: [{ key: cloudWanTagKey.Nfg, value: props.cloudWanNfgTag }],
    });

    // Routes - FW Subnet: NFW検査後のトラフィックをCloud WANへ戻す
    const fwCoreNetworkRoute = new ec2.CfnRoute(this, 'FwSubnetDefaultRoute', {
      routeTableId: fwSubnetRtb.ref,
      destinationCidrBlock: '0.0.0.0/0',
      coreNetworkArn: props.coreNetworkArn,
    });
    fwCoreNetworkRoute.addDependency(attachment);
  }
}
