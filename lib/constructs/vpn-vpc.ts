import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
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
}

export class VpnVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: VpnVpcProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // VPC + Subnet を L2 で構築
    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: 1,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
    this.vpc = vpc;

    const publicSubnet = vpc.selectSubnets({ subnetGroupName: "Public" })
      .subnets[0];
    const privateSubnet = vpc.selectSubnets({ subnetGroupName: "Private" })
      .subnets[0];

    // Security Groups (L2)
    const vpnSg = new ec2.SecurityGroup(this, "VpnSg", {
      vpc,
      description: "for VPN Router",
    });
    vpnSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(500));
    vpnSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(4500));
    for (const cidr of RFC1918_CIDRS) {
      vpnSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.allTraffic());
    }

    const ec2Sg = new ec2.SecurityGroup(this, "Ec2Sg", {
      vpc,
      description: "for EC2 instance",
    });
    for (const cidr of RFC1918_CIDRS) {
      ec2Sg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.allTraffic());
    }

    // VPN Router ENIs (L1: 複数 ENI + sourceDestCheck=false)
    const vpnEni0 = new ec2.CfnNetworkInterface(this, "VpnEni0", {
      description: "eth0",
      sourceDestCheck: false,
      subnetId: publicSubnet.subnetId,
      groupSet: [vpnSg.securityGroupId],
    });

    const vpnEni1 = new ec2.CfnNetworkInterface(this, "VpnEni1", {
      description: "eth1",
      sourceDestCheck: false,
      subnetId: privateSubnet.subnetId,
      groupSet: [vpnSg.securityGroupId],
    });

    // VPN Router EIP
    const vpnEip = new ec2.CfnEIP(this, "VpnEip", { domain: "vpc" });

    // Customer Gateway (L1: L2 なし)
    const cgw = new ec2.CfnCustomerGateway(this, "CustomerGateway", {
      type: "ipsec.1",
      bgpAsn: VPN_CONFIG.cgwBgpAsn,
      ipAddress: vpnEip.ref,
    });

    // CloudWatch Log Groups
    const vpnActivityLogGroup = new logs.LogGroup(this, "VpnActivityLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const vpnBgpLogGroup = new logs.LogGroup(this, "VpnBgpLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // VPN トンネルオプション (IKEv2)
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

    // VPN Connection (L1: Cloud WAN 用パターン + 詳細トンネルオプション)
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
    });

    // UserData (Fn::Sub で VPNID / REGION を置換)
    const userDataScript = fs.readFileSync(
      path.join(__dirname, "../../src/ec2/vpn-router-userdata.sh"),
      "utf-8"
    );
    const userDataWithVars = cdk.Fn.sub(userDataScript, {
      VPNID: vpnConn.ref,
      REGION: cdk.Aws.REGION,
      VPC_CIDR: props.vpcCidr,
    });

    // VPN Router 用 IAM Role (UserData で AWS API を呼ぶための最小権限)
    const vpnRouterRole = new iam.Role(this, "VpnRouterRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      inlinePolicies: {
        vpnRouterPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["ec2:DescribeVpnConnections", "ec2:DescribeInstances"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // VPN Router EC2 (L1: 3 ENI 構成)
    const vpnRouterAmiId = ssm.StringParameter.valueForStringParameter(
      this,
      "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64"
    );
    new ec2.CfnInstance(this, "VpnRouter", {
      imageId: vpnRouterAmiId,
      instanceType: "t3.small",
      iamInstanceProfile: new iam.CfnInstanceProfile(this, "VpnRouterProfile", {
        roles: [vpnRouterRole.roleName],
      }).ref,
      networkInterfaces: [
        { networkInterfaceId: vpnEni0.ref, deviceIndex: "0" },
        { networkInterfaceId: vpnEni1.ref, deviceIndex: "1" },
      ],
      userData: cdk.Fn.base64(userDataWithVars),
    });

    // EIP Association
    new ec2.CfnEIPAssociation(this, "VpnEipAssoc", {
      allocationId: vpnEip.attrAllocationId,
      networkInterfaceId: vpnEni0.attrId,
    });

    // オンプレミス側 EC2 (L2: 単一 ENI)
    new ec2.Instance(this, "Instance", {
      vpc,
      vpcSubnets: { subnets: [privateSubnet] },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      machineImage: ec2.MachineImage.fromSsmParameter(
        "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64"
      ),
      securityGroup: ec2Sg,
      ssmSessionPermissions: true,
    });

    // EIC Endpoint
    const eicSg = new ec2.SecurityGroup(this, "EicSg", {
      vpc,
      description: "for EIC Endpoint",
      allowAllOutbound: false,
    });
    eicSg.addEgressRule(ec2.Peer.ipv4(props.vpcCidr), ec2.Port.tcp(22));

    new ec2.CfnInstanceConnectEndpoint(this, "EicEndpoint", {
      subnetId: privateSubnet.subnetId,
      securityGroupIds: [eicSg.securityGroupId],
    });

    // Private Subnet ルート (VPN Router eth1 経由)
    new ec2.CfnRoute(this, "PrivateSubnetDefaultRoute", {
      routeTableId: privateSubnet.routeTable.routeTableId,
      destinationCidrBlock: "0.0.0.0/0",
      networkInterfaceId: vpnEni1.attrId,
    });

    // Cloud WAN Site-to-Site VPN Attachment
    new networkmanager.CfnSiteToSiteVpnAttachment(
      this,
      "SiteToSiteVpnAttachment",
      {
        coreNetworkId: props.coreNetworkId,
        vpnConnectionArn: cdk.Arn.format(
          {
            service: "ec2",
            resource: "vpn-connection",
            resourceName: vpnConn.ref,
          },
          stack
        ),
        tags: [
          { key: cloudWanTagKey.Segment, value: props.cloudWanSegmentTag },
        ],
      }
    );
  }
}
