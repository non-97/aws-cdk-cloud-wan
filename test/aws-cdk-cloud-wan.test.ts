import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { Region1Stack } from '../lib/region1-stack';
import { Region2Stack } from '../lib/region2-stack';

describe('Region1Stack', () => {
  const app = new cdk.App();
  const stack = new Region1Stack(app, 'TestRegion1Stack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
    region2: 'us-east-1',
  });
  const template = Template.fromStack(stack);

  test('creates Core Network', () => {
    template.hasResourceProperties('AWS::NetworkManager::GlobalNetwork', {
      Description: 'Cloud WAN Global Network',
    });
    template.hasResourceProperties('AWS::NetworkManager::CoreNetwork', {
      Description: 'Cloud WAN Core Network',
    });
  });

  test('creates VPC Attachments with correct tags', () => {
    template.hasResourceProperties('AWS::NetworkManager::VpcAttachment', {
      Tags: [{ Key: 'cloudwan-seg', Value: 'share' }],
    });
    template.hasResourceProperties('AWS::NetworkManager::VpcAttachment', {
      Tags: [{ Key: 'cloudwan-seg', Value: 'prod' }],
    });
    template.hasResourceProperties('AWS::NetworkManager::VpcAttachment', {
      Tags: [{ Key: 'cloudwan-nfg', Value: 'security' }],
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
      Tags: [{ Key: 'cloudwan-seg', Value: 'share' }],
    });
    template.hasResourceProperties('AWS::NetworkManager::VpcAttachment', {
      Tags: [{ Key: 'cloudwan-seg', Value: 'prod' }],
    });
  });

  test('creates VPN Connection and Customer Gateway', () => {
    template.hasResourceProperties('AWS::EC2::CustomerGateway', {
      Type: 'ipsec.1',
      BgpAsn: 64901,
    });
    template.hasResourceProperties('AWS::EC2::VPNConnection', {
      Type: 'ipsec.1',
      StaticRoutesOnly: false,
    });
  });

  test('creates Site-to-Site VPN Attachment', () => {
    template.hasResourceProperties('AWS::NetworkManager::SiteToSiteVpnAttachment', {
      Tags: [{ Key: 'cloudwan-seg', Value: 'dev' }],
    });
  });
});
