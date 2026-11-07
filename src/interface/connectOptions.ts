import type { IAuthPacket, IPublishPacket, QoS, UserProperties } from 'mqtt-packet';
import type { Duplex } from 'stream';
import type { PacketStore } from '../store.js';

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Acknowledgment completion accepts the original mutable native error.
export type LegacyAckCompletion = (error: Error | number | null, reasonCode?: number) => void;

export type LegacyAckHandler = (
  topic: string,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The legacy handler receives the original mutable payload buffer.
  payload: Buffer,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The legacy handler receives the original mutable publication packet.
  packet: IPublishPacket,
  complete: LegacyAckCompletion,
) => void;

export interface ConnectOptions {
  objectMode?: boolean;
  autoUseTopicAlias?: boolean;
  autoAssignTopicAlias?: boolean;
  topicAliasMaximum?: number;
  queueLimit?: number;
  cmd?: 'connect';
  clientId?: string;
  protocolVersion?: 4 | 5 | 3;
  protocolId?: 'MQTT' | 'MQIsdp';
  clean?: boolean;
  keepalive?: number;
  username?: string;
  password?: Buffer;
  will?: {
    topic: string;
    payload: Buffer;
    qos?: QoS;
    retain?: boolean;
    properties?: {
      willDelayInterval?: number;
      payloadFormatIndicator?: boolean;
      messageExpiryInterval?: number;
      contentType?: string;
      responseTopic?: string;
      correlationData?: Buffer;
      userProperties?: UserProperties;
    };
  };
  properties?: {
    sessionExpiryInterval?: number;
    receiveMaximum?: number;
    maximumPacketSize?: number;
    topicAliasMaximum?: number;
    requestResponseInformation?: boolean;
    requestProblemInformation?: boolean;
    userProperties?: UserProperties;
    authenticationMethod?: string;
    authenticationData?: Buffer;
  };
  brokerUrl?: URL;
  wsOptions?: Record<string, unknown>;
  tlsOptions?: Record<string, unknown>;
  reschedulePings?: boolean;
  reconnectPeriod?: number;
  connectTimeout?: number;
  incomingStore?: PacketStore;
  outgoingStore?: PacketStore;
  queueQoSZero?: boolean;
  customHandleAcks?: LegacyAckHandler;
  authPacket?: Partial<IAuthPacket>;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Custom factories receive the existing mutable endpoint and stream configuration.
  transformWsUrl?: (options: URL | undefined) => URL;
  resubscribe?: boolean;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Custom factories receive the existing mutable endpoint and stream configuration.
  customStreamFactory?: (options: ConnectOptions) => Duplex;
}
