#!/bin/bash -xe

# CloudFormation Fn::Sub による変数置換について:
# ${VPNID}, ${REGION}, ${VPC_CIDR} はデプロイ時に CloudFormation が実際の値に置換する。
# ${!VAR} はシェル変数として EC2 起動時に展開される (Fn::Sub のエスケープ記法)。

#######################################
# 1. パッケージ導入
#######################################

# IP フォワーディングを有効化 (VPN ルーターとしてパケットを転送するため)
sysctl -w net.ipv4.ip_forward=1
echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.d/99-vpn.conf
sysctl -p /etc/sysctl.d/99-vpn.conf

# IPsec (Libreswan) と関連ツールを導入
dnf install -y jq unzip libreswan

# FRR は AL2023 標準リポジトリに含まれないため、SPAL から導入する
dnf install -y spal-release
dnf install -y frr

#######################################
# 2. FRR デーモン設定
#######################################

# BGP デーモンを有効化 (デフォルトでは無効)
sed -i "s/bgpd=.*/bgpd=yes/g" /etc/frr/daemons

# zebra に -n フラグを追加して netns バックエンドを有効化する。
# これにより FRR がネットワーク namespace (vrf1) 内のインターフェースを認識できる。
# -n がないと vrf-id が -1 になり BGP セッションが確立しない。
sed -i 's/zebra_options=" *-A/zebra_options=" -n -A/g' /etc/frr/daemons

#######################################
# 3. Libreswan 初期化
#######################################

# NSS 暗号データベースを初期化 (Libreswan が証明書/鍵を管理するために使用)
ipsec initnss 2>/dev/null || true

#######################################
# 4. IP アドレス / VPN トンネル情報の取得
#######################################

# IMDSv2 トークンを取得 (スクリプト後半でも IMDS を使うため、VPN 待機時間を考慮して TTL を長めに設定)
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 1800")
CGW_IP_ADDRESS=$(curl -s -H "X-aws-ec2-metadata-token: ${!TOKEN}" http://169.254.169.254/latest/meta-data/public-ipv4)
CGW_PRIVATE_IP_ADDRESS=$(curl -s -H "X-aws-ec2-metadata-token: ${!TOKEN}" http://169.254.169.254/latest/meta-data/local-ipv4)

# AWS API から VPN トンネル情報を1回だけ取得 (API コール削減 + スロットリング回避)
VPN_JSON=$(aws ec2 describe-vpn-connections --vpn-connection-ids ${VPNID} --region ${REGION} --no-cli-pager)
OUTSIDE_IP_ADDRESS1=$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[].Options.TunnelOptions[0].OutsideIpAddress')
OUTSIDE_IP_ADDRESS2=$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[].Options.TunnelOptions[1].OutsideIpAddress')

#######################################
# 5. Libreswan (IPsec) 設定
#######################################

# Pre-Shared Key の設定
cat <<IPSECSECRETSEOF > /etc/ipsec.d/cloudwan.secrets
${!CGW_IP_ADDRESS} ${!OUTSIDE_IP_ADDRESS1} : PSK "vpnsecret"
${!CGW_IP_ADDRESS} ${!OUTSIDE_IP_ADDRESS2} : PSK "vpnsecret"
IPSECSECRETSEOF

# IPsec トンネル設定
# - ikev2=insist: IKEv2 を強制 (AWS VPN の設定に合わせる)
# - dpddelay/dpdtimeout: DPD プローブを10秒間隔で送信し、AWS が tunnel UP を認識できるようにする
# - vti-interface: Libreswan が自動で VTI デバイスを作成する
# - vti-routing=no: VTI のルーティングは FRR (BGP) に任せる
cat <<IPSECCONFEOF > /etc/ipsec.d/cloudwan.conf
conn tunnel1
  type=tunnel
  auto=start
  authby=secret
  ikev2=insist
  ike=aes256-sha2_256;dh14
  esp=aes256-sha2_256;dh14
  ikelifetime=28800s
  salifetime=3600s
  rekey=yes
  dpddelay=10
  dpdtimeout=30
  dpdaction=restart
  left=${!CGW_PRIVATE_IP_ADDRESS}
  leftid=${!CGW_IP_ADDRESS}
  leftsubnet=0.0.0.0/0
  right=${!OUTSIDE_IP_ADDRESS1}
  rightid=${!OUTSIDE_IP_ADDRESS1}
  rightsubnet=0.0.0.0/0
  mark=100/0xffffffff
  vti-interface=vti1
  vti-routing=no

conn tunnel2
  type=tunnel
  auto=start
  authby=secret
  ikev2=insist
  ike=aes256-sha2_256;dh14
  esp=aes256-sha2_256;dh14
  ikelifetime=28800s
  salifetime=3600s
  rekey=yes
  dpddelay=10
  dpdtimeout=30
  dpdaction=restart
  left=${!CGW_PRIVATE_IP_ADDRESS}
  leftid=${!CGW_IP_ADDRESS}
  leftsubnet=0.0.0.0/0
  right=${!OUTSIDE_IP_ADDRESS2}
  rightid=${!OUTSIDE_IP_ADDRESS2}
  rightsubnet=0.0.0.0/0
  mark=200/0xffffffff
  vti-interface=vti2
  vti-routing=no
IPSECCONFEOF

#######################################
# 6. IPsec 起動 + トンネル接続
#######################################

systemctl enable ipsec
systemctl start ipsec

# スタック新規作成時、SiteToSiteVpnAttachment の作成に10分以上かかる。
# VPN エンドポイントが応答可能になるまで待機しないと ipsec auto --up が失敗する。
echo "VPN Connection が利用可能になるまで待機中..."
for i in $(seq 1 90); do
  STATE=$(aws ec2 describe-vpn-connections --vpn-connection-ids ${VPNID} --region ${REGION} --no-cli-pager 2>/dev/null | jq -r '.VpnConnections[].State')
  if [ "${!STATE}" = "available" ]; then
    echo "VPN Connection が利用可能 (${!i}回目の確認)"
    break
  fi
  echo "VPN Connection 待機中... (state: ${!STATE}, ${!i}/90)"
  sleep 10
done

# ipsec を再起動して最新の設定をロードし、明示的に接続を開始する。
# VPN エンドポイントが応答可能になった直後でも数秒かかる場合があるため retry する。
ipsec restart
sleep 5

for i in $(seq 1 30); do
  if ipsec auto --up tunnel1 2>&1 | grep -q "established"; then
    echo "Tunnel 1 established"
    break
  fi
  echo "Tunnel 1 接続試行中... (${!i}/30)"
  sleep 10
done

for i in $(seq 1 30); do
  if ipsec auto --up tunnel2 2>&1 | grep -q "established"; then
    echo "Tunnel 2 established"
    break
  fi
  echo "Tunnel 2 接続試行中... (${!i}/30)"
  sleep 10
done

#######################################
# 7. VTI 作成待ち
#######################################

# Libreswan が IPsec SA 確立時に VTI デバイスを自動作成する。
# VTI がないと後続の IP 設定や namespace 移動ができないため待機する。
for i in $(seq 1 30); do
  if ip link show vti1 > /dev/null 2>&1 && ip link show vti2 > /dev/null 2>&1; then
    echo "VTI デバイス作成完了"
    break
  fi
  echo "VTI 作成待機中... (${!i}/30)"
  sleep 2
done

#######################################
# 8. ネットワーク namespace 構築
#######################################

# namespace を使ってオンプレミス LAN 側 (ens6) と VPN トンネル (vti1/2) を
# メインの VPC ルーティングから分離する。
# これにより FRR の BGP 経路と VPC ローカル経路が干渉しない。
NAMESPACE=vrf1
ip netns add ${!NAMESPACE}

# IMDS の MAC アドレスで DeviceIndex=1 のインターフェース名を動的に検出する。
# AL2023 では予測可能な命名 (ens6 等) が使われるが、インスタンスタイプにより異なる可能性があるため固定値にしない。
for mac in $(curl -s -H "X-aws-ec2-metadata-token: ${!TOKEN}" http://169.254.169.254/latest/meta-data/network/interfaces/macs/ | tr -d '/'); do
  dn=$(curl -s -H "X-aws-ec2-metadata-token: ${!TOKEN}" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${!mac}/device-number")
  if [ "${!dn}" = "1" ]; then
    ETH1_IFACE=$(ip -o link | grep -i "${!mac}" | awk -F': ' '{print $2}')
    ETH1_IP=$(curl -s -H "X-aws-ec2-metadata-token: ${!TOKEN}" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${!mac}/local-ipv4s")
    echo "DeviceIndex 1 = ${!ETH1_IFACE} (MAC: ${!mac}, IP: ${!ETH1_IP})"
    break
  fi
done

# オンプレミス LAN 側インターフェースを namespace に移動
ip link set ${!ETH1_IFACE} netns ${!NAMESPACE} up
ip netns exec ${!NAMESPACE} ip addr add ${!ETH1_IP}/24 dev ${!ETH1_IFACE}

#######################################
# 9. VTI を namespace に移動 + トンネル内部 IP 設定
#######################################

# VTI を namespace に移動することで、BGP ピアリングが vrf1 内で行われる
ip link set vti1 netns ${!NAMESPACE}
ip netns exec ${!NAMESPACE} ip link set vti1 up mtu 1436
ip link set vti2 netns ${!NAMESPACE}
ip netns exec ${!NAMESPACE} ip link set vti2 up mtu 1436

# トンネル内部 IP を AWS API から取得して設定する。
# /30 サブネットの network+1 が AWS 側、network+2 が CGW 側。
TUNNEL_IP_CIDR1=$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[].Options.TunnelOptions[0].TunnelInsideCidr')
TUNNEL_IP_CIDR2=$(echo "${!VPN_JSON}" | jq -r '.VpnConnections[].Options.TunnelOptions[1].TunnelInsideCidr')

TUNNEL_NET1=$(echo ${!TUNNEL_IP_CIDR1} | cut -d/ -f1 | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, int($4/4)*4}')
TUNNEL_IP_ADDRESS1_AWS=$(echo ${!TUNNEL_NET1} | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, $4+1}')
TUNNEL_IP_ADDRESS1_CGW=$(echo ${!TUNNEL_NET1} | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, $4+2}')
TUNNEL_NET2=$(echo ${!TUNNEL_IP_CIDR2} | cut -d/ -f1 | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, int($4/4)*4}')
TUNNEL_IP_ADDRESS2_AWS=$(echo ${!TUNNEL_NET2} | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, $4+1}')
TUNNEL_IP_ADDRESS2_CGW=$(echo ${!TUNNEL_NET2} | awk -F. '{printf "%s.%s.%s.%d", $1, $2, $3, $4+2}')

ip netns exec ${!NAMESPACE} ip addr add ${!TUNNEL_IP_ADDRESS1_CGW}/30 dev vti1
ip netns exec ${!NAMESPACE} ip addr add ${!TUNNEL_IP_ADDRESS2_CGW}/30 dev vti2

#######################################
# 10. FRR (BGP) 設定
#######################################

# VRF vrf1 で BGP を動作させ、Cloud WAN とルートを交換する。
# - AS 64901: このオンプレミスルーターの AS 番号
# - remote-as 65002: Cloud WAN の Region2 側 ASN
# - aggregate-address: VPC CIDR をサマリーとして広告
# - route-map ALLOW_OUT: 広告するプレフィックスを制限
cat <<FRREOF > /etc/frr/frr.conf
frr version 10.4
frr defaults traditional
hostname vpn-router
log syslog informational
no ipv6 forwarding
!
vrf vrf1
 netns /run/netns/vrf1
exit-vrf
!
router bgp 64901 vrf vrf1
 no bgp ebgp-requires-policy
 neighbor ${!TUNNEL_IP_ADDRESS1_AWS} remote-as 65002
 neighbor ${!TUNNEL_IP_ADDRESS1_AWS} ebgp-multihop 255
 neighbor ${!TUNNEL_IP_ADDRESS2_AWS} remote-as 65002
 neighbor ${!TUNNEL_IP_ADDRESS2_AWS} ebgp-multihop 255
 !
 address-family ipv4 unicast
  redistribute connected
  aggregate-address ${VPC_CIDR} summary-only
  neighbor ${!TUNNEL_IP_ADDRESS1_AWS} soft-reconfiguration inbound
  neighbor ${!TUNNEL_IP_ADDRESS2_AWS} soft-reconfiguration inbound
  neighbor ${!TUNNEL_IP_ADDRESS1_AWS} route-map ALLOW_OUT out
  neighbor ${!TUNNEL_IP_ADDRESS2_AWS} route-map ALLOW_OUT out
 exit-address-family
exit
!
ip prefix-list LOCAL seq 5 permit ${VPC_CIDR}
!
route-map ALLOW_OUT permit 10
 match ip address prefix-list LOCAL
exit
!
end
FRREOF

systemctl enable frr
systemctl restart frr
