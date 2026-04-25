/**
 * ネットワーク設定の一元管理。
 * 全CIDR / IP / ASN / セグメント名をここで定義し、Stack / Construct にProps経由で注入する。
 */

/** RFC1918 プライベートアドレス帯 */
export const RFC1918_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
] as const;

/** Cloud WAN Attachment タグキー */
export const cloudWanTagKey = {
  Segment: 'cloudwan-seg',
  Nfg: 'cloudwan-nfg',
} as const;

/** Cloud WAN セグメント名 */
export const cloudWanSegment = {
  Share: 'share',
  Prod: 'prod',
  Dev: 'dev',
} as const;

/** Cloud WAN Network Function Group 名 */
export const cloudWanNfg = {
  Security: 'security',
} as const;

/** Cloud WAN Core Network 設定 */
export const CORE_NETWORK_CONFIG = {
  insideCidrBlocks: ['192.168.0.0/16'],
  asnRanges: ['65000-65099'],
  region1Asn: 65001,
  region2Asn: 65002,
  region2InsideCidr: '192.168.100.0/24',
} as const;

/** VPN 設定 */
export const VPN_CONFIG = {
  cgwBgpAsn: 64901,
  preSharedKey: 'vpnsecret',
  tunnel1InsideCidr: '169.254.10.0/30',
  tunnel2InsideCidr: '169.254.10.4/30',
} as const;

/** VPC ごとのネットワーク設定 */
export interface VpcNetworkConfig {
  readonly vpcCidr: string;
}

/** リージョンごとのネットワーク設定 */
export interface RegionNetworkConfig {
  readonly egress: VpcNetworkConfig;
  readonly prodPrivate: VpcNetworkConfig;
  readonly devPrivate?: VpcNetworkConfig;

  readonly inspection?: VpcNetworkConfig;
  readonly vpn?: VpcNetworkConfig;
}

/** Region1 ネットワーク設定 */
export const REGION1_NETWORK: RegionNetworkConfig = {
  egress: { vpcCidr: '10.0.0.0/16' },
  prodPrivate: { vpcCidr: '10.1.0.0/16' },
  devPrivate: { vpcCidr: '10.2.0.0/16' },
  inspection: { vpcCidr: '10.3.0.0/16' },
};

/** Region2 ネットワーク設定 */
export const REGION2_NETWORK: RegionNetworkConfig = {
  egress: { vpcCidr: '10.100.0.0/16' },
  prodPrivate: { vpcCidr: '10.101.0.0/16' },
  vpn: { vpcCidr: '10.102.0.0/16' },
};

/** NFW ルール変数で使う全 VPC CIDR のマップ (キー名は NFW の IP Set 変数名として使用される) */
export const ALL_VPC_CIDRS = {
  Region1_EgressVPC_NET: [REGION1_NETWORK.egress.vpcCidr],
  Region1_ProdPrivateVPC_NET: [REGION1_NETWORK.prodPrivate.vpcCidr],
  Region1_DevPrivateVPC_NET: [REGION1_NETWORK.devPrivate!.vpcCidr],
  Region2_EgressVPC_NET: [REGION2_NETWORK.egress.vpcCidr],
  Region2_ProdPrivateVPC_NET: [REGION2_NETWORK.prodPrivate.vpcCidr],
  Region2_VpnVPC_NET: [REGION2_NETWORK.vpn!.vpcCidr],
} as const;
