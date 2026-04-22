import * as cdk from 'aws-cdk-lib/core';
import * as networkmanager from 'aws-cdk-lib/aws-networkmanager';
import { Construct } from 'constructs';
import { CORE_NETWORK_CONFIG, cloudWanSegment, cloudWanNfg, cloudWanTagKey } from '../network-config';

export interface CoreNetworkProps {
  /** Cloud WAN Edge Location 1 のリージョン */
  readonly region1: string;
  /** Cloud WAN Edge Location 2 のリージョン */
  readonly region2: string;
}

export class CoreNetwork extends Construct {
  public readonly coreNetworkId: string;
  public readonly coreNetworkArn: string;
  public readonly globalNetworkId: string;

  constructor(scope: Construct, id: string, props: CoreNetworkProps) {
    super(scope, id);

    const globalNetwork = new networkmanager.CfnGlobalNetwork(this, 'GlobalNetwork', {
      description: 'Cloud WAN Global Network',
    });

    const coreNetwork = new networkmanager.CfnCoreNetwork(this, 'CoreNetwork', {
      description: 'Cloud WAN Core Network',
      globalNetworkId: globalNetwork.attrId,
      policyDocument: {
        version: '2021.12',
        'core-network-configuration': {
          'vpn-ecmp-support': true,
          'inside-cidr-blocks': CORE_NETWORK_CONFIG.insideCidrBlocks,
          'asn-ranges': CORE_NETWORK_CONFIG.asnRanges,
          'edge-locations': [
            {
              location: props.region1,
              asn: CORE_NETWORK_CONFIG.region1Asn,
            },
            {
              location: props.region2,
              asn: CORE_NETWORK_CONFIG.region2Asn,
              'inside-cidr-blocks': [CORE_NETWORK_CONFIG.region2InsideCidr],
            },
          ],
        },
        segments: [
          {
            name: cloudWanSegment.Share,
            'require-attachment-acceptance': false,
            'edge-locations': [props.region1, props.region2],
          },
          {
            name: cloudWanSegment.Prod,
            'require-attachment-acceptance': false,
            'edge-locations': [props.region1, props.region2],
          },
          {
            name: cloudWanSegment.Dev,
            'require-attachment-acceptance': false,
            'edge-locations': [props.region2],
          },
        ],
        'network-function-groups': [
          {
            name: cloudWanNfg.Security,
            'require-attachment-acceptance': false,
          },
        ],
        'segment-actions': [
          {
            action: 'share',
            mode: 'attachment-route',
            segment: cloudWanSegment.Share,
            'share-with': [cloudWanSegment.Dev],
          },
          {
            action: 'send-via',
            segment: cloudWanSegment.Prod,
            mode: 'single-hop',
            'when-sent-to': {
              segments: [cloudWanSegment.Share],
            },
            via: {
              'network-function-groups': [cloudWanNfg.Security],
            },
          },
        ],
        'attachment-policies': [
          {
            'rule-number': 100,
            description: 'attachment segment shared',
            'condition-logic': 'or',
            conditions: [
              {
                type: 'tag-value',
                operator: 'equals',
                key: cloudWanTagKey.Segment,
                value: cloudWanSegment.Share,
              },
            ],
            action: {
              'association-method': 'constant',
              segment: cloudWanSegment.Share,
            },
          },
          {
            'rule-number': 200,
            description: 'attachment segment prod',
            'condition-logic': 'or',
            conditions: [
              {
                type: 'tag-value',
                operator: 'equals',
                key: cloudWanTagKey.Segment,
                value: cloudWanSegment.Prod,
              },
            ],
            action: {
              'association-method': 'constant',
              segment: cloudWanSegment.Prod,
            },
          },
          {
            'rule-number': 300,
            description: 'attachment segment dev',
            'condition-logic': 'or',
            conditions: [
              {
                type: 'tag-value',
                operator: 'equals',
                key: cloudWanTagKey.Segment,
                value: cloudWanSegment.Dev,
              },
            ],
            action: {
              'association-method': 'constant',
              segment: cloudWanSegment.Dev,
            },
          },
          {
            'rule-number': 400,
            description: 'attachment network-function-groups security',
            'condition-logic': 'or',
            conditions: [
              {
                type: 'tag-value',
                operator: 'equals',
                key: cloudWanTagKey.Nfg,
                value: cloudWanNfg.Security,
              },
            ],
            action: {
              'add-to-network-function-group': cloudWanNfg.Security,
            },
          },
        ],
      },
    });

    this.globalNetworkId = globalNetwork.attrId;
    this.coreNetworkId = coreNetwork.attrCoreNetworkId;
    this.coreNetworkArn = coreNetwork.attrCoreNetworkArn;
  }
}
