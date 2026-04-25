import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { Region1Stack } from '../lib/region1-stack';
import { Region2Stack } from '../lib/region2-stack';
import { cloudWanTagKey, cloudWanSegment, cloudWanNfg, VPN_CONFIG } from '../lib/network-config';

describe('Region1Stack', () => {
  const app = new cdk.App();
  const stack = new Region1Stack(app, 'TestRegion1Stack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
    region2: 'us-east-1',
  });
  const template = Template.fromStack(stack);

  test('creates Core Network', () => {
    template.hasResourceProperties('AWS::NetworkManager::GlobalNetwork', {});
    template.hasResourceProperties('AWS::NetworkManager::CoreNetwork', {});
  });

  test('creates VPC Attachments with correct tags', () => {
    template.hasResourceProperties('AWS::NetworkManager::VpcAttachment', {
      Tags: [{ Key: cloudWanTagKey.Segment, Value: cloudWanSegment.Share }],
    });
    template.hasResourceProperties('AWS::NetworkManager::VpcAttachment', {
      Tags: [{ Key: cloudWanTagKey.Segment, Value: cloudWanSegment.Prod }],
    });
    template.hasResourceProperties('AWS::NetworkManager::VpcAttachment', {
      Tags: [{ Key: cloudWanTagKey.Segment, Value: cloudWanSegment.Dev }],
    });
    template.hasResourceProperties('AWS::NetworkManager::VpcAttachment', {
      Tags: [{ Key: cloudWanTagKey.Nfg, Value: cloudWanNfg.Security }],
    });
  });

  test('creates Network Firewall', () => {
    template.resourceCountIs('AWS::NetworkFirewall::Firewall', 1);
    template.resourceCountIs('AWS::NetworkFirewall::FirewallPolicy', 1);
    template.resourceCountIs('AWS::NetworkFirewall::RuleGroup', 1);
  });
});

describe('Region2Stack', () => {
  const app = new cdk.App();
  const stack = new Region2Stack(app, 'TestRegion2Stack', {
    env: { account: '123456789012', region: 'us-east-1' },
    coreNetworkId: 'core-network-123',
    coreNetworkArn: 'arn:aws:networkmanager::123456789012:core-network/core-network-123',
  });
  const template = Template.fromStack(stack);

  test('creates VPC Attachments with correct tags', () => {
    template.hasResourceProperties('AWS::NetworkManager::VpcAttachment', {
      Tags: [{ Key: cloudWanTagKey.Segment, Value: cloudWanSegment.Share }],
    });
    template.hasResourceProperties('AWS::NetworkManager::VpcAttachment', {
      Tags: [{ Key: cloudWanTagKey.Segment, Value: cloudWanSegment.Prod }],
    });
  });

  test('creates VPN Connection and Customer Gateway', () => {
    template.hasResourceProperties('AWS::EC2::CustomerGateway', {
      Type: 'ipsec.1',
      BgpAsn: VPN_CONFIG.cgwBgpAsn,
    });
    template.hasResourceProperties('AWS::EC2::VPNConnection', {
      Type: 'ipsec.1',
      StaticRoutesOnly: false,
    });
  });

  test('creates Site-to-Site VPN Attachment', () => {
    template.hasResourceProperties('AWS::NetworkManager::SiteToSiteVpnAttachment', {
      Tags: [{ Key: cloudWanTagKey.Segment, Value: cloudWanSegment.Dev }],
    });
  });
});
