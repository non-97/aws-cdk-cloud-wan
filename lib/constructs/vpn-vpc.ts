import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as logs from "aws-cdk-lib/aws-logs";
import * as networkmanager from "aws-cdk-lib/aws-networkmanager";
import * as path from "path";
import * as fs from "fs";
import { Construct } from "constructs";
import { RFC1918_CIDRS, VPN_CONFIG, cloudWanTagKey } from "../network-config";

export interface VpnVpcProps {
  /** VPC CIDR ブロック */
  readonly vpcCidr: string;
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN セグメント タグ値 */
  readonly cloudWanSegmentTag: string;
  /** EC2 インスタンスプロファイル ARN */
  readonly instanceProfileArn: string;
}

export class VpnVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: VpnVpcProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const az = cdk.Fn.select(0, cdk.Fn.getAzs());

    // VPC
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      enableDnsSupport: true,
      enableDnsHostnames: true,
      subnetConfiguration: [],
      natGateways: 0,
    });
    this.vpc = vpc;

    // Subnets
    const publicSubnet = new ec2.CfnSubnet(this, "PublicSubnet", {
      vpcId: vpc.vpcId,
      cidrBlock: cdk.Fn.select(0, cdk.Fn.cidr(props.vpcCidr, 11, "8")),
      availabilityZone: az,
      tags: [{ key: "Name", value: `${stack.stackName}-VpnVpc-PublicSubnet` }],
    });

    const privateSubnet = new ec2.CfnSubnet(this, "PrivateSubnet", {
      vpcId: vpc.vpcId,
      cidrBlock: cdk.Fn.select(1, cdk.Fn.cidr(props.vpcCidr, 11, "8")),
      availabilityZone: az,
      tags: [{ key: "Name", value: `${stack.stackName}-VpnVpc-PrivateSubnet` }],
    });

    const private2Subnet = new ec2.CfnSubnet(this, "Private2Subnet", {
      vpcId: vpc.vpcId,
      cidrBlock: cdk.Fn.select(2, cdk.Fn.cidr(props.vpcCidr, 11, "8")),
      availabilityZone: az,
      tags: [
        { key: "Name", value: `${stack.stackName}-VpnVpc-Private2Subnet` },
      ],
    });

    // Internet Gateway
    const igw = new ec2.CfnInternetGateway(this, "Igw", {});
    new ec2.CfnVPCGatewayAttachment(this, "IgwAttach", {
      internetGatewayId: igw.ref,
      vpcId: vpc.vpcId,
    });

    // Route Tables
    const publicSubnetRtb = new ec2.CfnRouteTable(this, "PublicSubnetRtb", {
      vpcId: vpc.vpcId,
      tags: [
        { key: "Name", value: `${stack.stackName}-VpnVpc-PublicSubnetRtb` },
      ],
    });

    const privateSubnetRtb = new ec2.CfnRouteTable(this, "PrivateSubnetRtb", {
      vpcId: vpc.vpcId,
      tags: [
        { key: "Name", value: `${stack.stackName}-VpnVpc-PrivateSubnetRtb` },
      ],
    });

    // Route Table Associations
    new ec2.CfnSubnetRouteTableAssociation(this, "PublicSubnetRtbAssoc", {
      subnetId: publicSubnet.ref,
      routeTableId: publicSubnetRtb.ref,
    });

    new ec2.CfnSubnetRouteTableAssociation(this, "PrivateSubnetRtbAssoc", {
      subnetId: privateSubnet.ref,
      routeTableId: privateSubnetRtb.ref,
    });

    // Routes - Public Subnet
    new ec2.CfnRoute(this, "PublicSubnetDefaultRoute", {
      routeTableId: publicSubnetRtb.ref,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: igw.ref,
    });

    // Security Groups
    const vpnSg = new ec2.CfnSecurityGroup(this, "VpnSg", {
      groupDescription: "for VPN Router",
      vpcId: vpc.vpcId,
      securityGroupIngress: [
        { ipProtocol: "udp", fromPort: 500, toPort: 500, cidrIp: "0.0.0.0/0" },
        {
          ipProtocol: "udp",
          fromPort: 4500,
          toPort: 4500,
          cidrIp: "0.0.0.0/0",
        },
        ...RFC1918_CIDRS.map((cidr) => ({
          ipProtocol: "-1",
          fromPort: -1,
          toPort: -1,
          cidrIp: cidr,
        })),
      ],
      tags: [{ key: "Name", value: `${stack.stackName}-VpnVpc-VpnSg` }],
    });

    const ec2Sg = new ec2.CfnSecurityGroup(this, "Ec2Sg", {
      groupDescription: "for EC2 instance",
      vpcId: vpc.vpcId,
      securityGroupIngress: RFC1918_CIDRS.map((cidr) => ({
        ipProtocol: "-1",
        fromPort: -1,
        toPort: -1,
        cidrIp: cidr,
      })),
      tags: [{ key: "Name", value: `${stack.stackName}-VpnVpc-Ec2Sg` }],
    });

    // VPN Router ENIs
    const vpnEni0 = new ec2.CfnNetworkInterface(this, "VpnEni0", {
      description: "eth0",
      privateIpAddress: "10.102.0.100",
      sourceDestCheck: false,
      subnetId: publicSubnet.ref,
      groupSet: [vpnSg.attrGroupId],
    });

    const vpnEni1 = new ec2.CfnNetworkInterface(this, "VpnEni1", {
      description: "eth1",
      privateIpAddress: "10.102.1.101",
      sourceDestCheck: false,
      subnetId: privateSubnet.ref,
      groupSet: [vpnSg.attrGroupId],
    });

    const vpnEni2 = new ec2.CfnNetworkInterface(this, "VpnEni2", {
      description: "eth2",
      subnetId: private2Subnet.ref,
      groupSet: [vpnSg.attrGroupId],
    });

    // VPN Router EIP
    const vpnEip = new ec2.CfnEIP(this, "VpnEip", { domain: "vpc" });

    // Customer Gateway
    const cgw = new ec2.CfnCustomerGateway(this, "CustomerGateway", {
      type: "ipsec.1",
      bgpAsn: VPN_CONFIG.cgwBgpAsn,
      ipAddress: vpnEip.ref,
      tags: [{ key: "Name", value: `${stack.stackName}-Cgw` }],
    });

    // CloudWatch Log Groups for VPN tunnel logging
    const vpnActivityLogGroup = new logs.LogGroup(this, "VpnActivityLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const vpnBgpLogGroup = new logs.LogGroup(this, "VpnBgpLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Shared tunnel options (IKEv2, matching screenshot configuration)
    const tunnelOptions = {
      ikeVersions: [{ value: "ikev2" }],
      phase1EncryptionAlgorithms: [
        { value: "AES256" },
        { value: "AES128-GCM-16" },
        { value: "AES256-GCM-16" },
      ],
      phase1IntegrityAlgorithms: [
        { value: "SHA2-256" },
        { value: "SHA2-384" },
        { value: "SHA2-512" },
      ],
      phase1DhGroupNumbers: [
        { value: 14 },
        { value: 15 },
        { value: 16 },
        { value: 19 },
        { value: 20 },
        { value: 21 },
        { value: 22 },
        { value: 23 },
        { value: 24 },
      ],
      phase2EncryptionAlgorithms: [
        { value: "AES256" },
        { value: "AES128-GCM-16" },
        { value: "AES256-GCM-16" },
      ],
      phase2IntegrityAlgorithms: [
        { value: "SHA2-256" },
        { value: "SHA2-384" },
        { value: "SHA2-512" },
      ],
      phase2DhGroupNumbers: [
        { value: 14 },
        { value: 15 },
        { value: 16 },
        { value: 19 },
        { value: 20 },
        { value: 21 },
        { value: 22 },
        { value: 23 },
        { value: 24 },
      ],
      dpdTimeoutAction: "clear",
      startupAction: "add",
      logOptions: {
        cloudwatchLogOptions: {
          logEnabled: true,
          logGroupArn: cdk.Arn.format(
            {
              service: "logs",
              resource: "log-group",
              resourceName: vpnActivityLogGroup.logGroupName,
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            },
            stack
          ),
          logOutputFormat: "json",
          bgpLogEnabled: true,
          bgpLogGroupArn: cdk.Arn.format(
            {
              service: "logs",
              resource: "log-group",
              resourceName: vpnBgpLogGroup.logGroupName,
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            },
            stack
          ),
          bgpLogOutputFormat: "json",
        },
      },
    };

    // VPN Connection (no gateway - attached to Cloud WAN via S2S Attachment)
    const vpnConn = new ec2.CfnVPNConnection(this, "VpnConnection", {
      type: "ipsec.1",
      staticRoutesOnly: false,
      customerGatewayId: cgw.ref,
      vpnTunnelOptionsSpecifications: [
        {
          preSharedKey: VPN_CONFIG.preSharedKey,
          tunnelInsideCidr: VPN_CONFIG.tunnel1InsideCidr,
          ...tunnelOptions,
        },
        {
          preSharedKey: VPN_CONFIG.preSharedKey,
          tunnelInsideCidr: VPN_CONFIG.tunnel2InsideCidr,
          ...tunnelOptions,
        },
      ],
      tags: [{ key: "Name", value: `${stack.stackName}-VpnConn` }],
    });

    // Read UserData script and substitute variables
    const userDataScript = fs.readFileSync(
      path.join(__dirname, "../../src/ec2/vpn-router-userdata.sh"),
      "utf-8"
    );
    const userDataWithVars = cdk.Fn.sub(userDataScript, {
      VPNID: vpnConn.ref,
      REGION: cdk.Aws.REGION,
    });

    // VPN Router EC2 Instance (Amazon Linux 2023 with Libreswan + FRR)
    const vpnRouterAmiId = ssm.StringParameter.valueForStringParameter(
      this,
      "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64"
    );
    const vpnRouter = new ec2.CfnInstance(this, "VpnRouter", {
      imageId: vpnRouterAmiId,
      instanceType: "t3.small",
      iamInstanceProfile: props.instanceProfileArn,
      networkInterfaces: [
        { networkInterfaceId: vpnEni0.ref, deviceIndex: "0" },
        { networkInterfaceId: vpnEni1.ref, deviceIndex: "1" },
        { networkInterfaceId: vpnEni2.ref, deviceIndex: "2" },
      ],
      userData: cdk.Fn.base64(userDataWithVars),
      tags: [{ key: "Name", value: `${stack.stackName}-VpnRouter` }],
    });

    // EIP Association (after IGW attachment)
    new ec2.CfnEIPAssociation(this, "VpnEipAssoc", {
      allocationId: vpnEip.attrAllocationId,
      networkInterfaceId: vpnEni0.attrId,
    });

    // EC2 Instance (on-premise simulation)
    const al2023AmiId = ssm.StringParameter.valueForStringParameter(
      this,
      "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64"
    );
    new ec2.CfnInstance(this, "Instance", {
      imageId: al2023AmiId,
      instanceType: "t3.micro",
      iamInstanceProfile: props.instanceProfileArn,
      networkInterfaces: [
        {
          deviceIndex: "0",
          subnetId: privateSubnet.ref,
          groupSet: [ec2Sg.attrGroupId],
          privateIpAddresses: [
            { privateIpAddress: "10.102.1.100", primary: true },
          ],
        },
      ],
      tags: [{ key: "Name", value: `${stack.stackName}-VpnVpc-Instance` }],
    });

    // EIC Endpoint
    const eicSg = new ec2.CfnSecurityGroup(this, "EicSg", {
      groupDescription: "for EIC Endpoint",
      vpcId: vpc.vpcId,
      securityGroupEgress: [
        { ipProtocol: "tcp", fromPort: 22, toPort: 22, cidrIp: props.vpcCidr },
      ],
      tags: [{ key: "Name", value: `${stack.stackName}-VpnVpc-EicSg` }],
    });

    new ec2.CfnInstanceConnectEndpoint(this, "EicEndpoint", {
      subnetId: private2Subnet.ref,
      securityGroupIds: [eicSg.attrGroupId],
    });

    // Routes - Private Subnet (via VPN Router eth1)
    new ec2.CfnRoute(this, "PrivateSubnetDefaultRoute", {
      routeTableId: privateSubnetRtb.ref,
      destinationCidrBlock: "0.0.0.0/0",
      networkInterfaceId: vpnEni1.attrId,
    });

    // Cloud WAN Site-to-Site VPN Attachment
    const vpnConnArn = cdk.Arn.format(
      {
        service: "ec2",
        resource: "vpn-connection",
        resourceName: vpnConn.ref,
      },
      stack
    );

    new networkmanager.CfnSiteToSiteVpnAttachment(
      this,
      "SiteToSiteVpnAttachment",
      {
        coreNetworkId: props.coreNetworkId,
        vpnConnectionArn: vpnConnArn,
        tags: [
          { key: cloudWanTagKey.Segment, value: props.cloudWanSegmentTag },
        ],
      }
    );
  }
}
