import type { UserProperty, WirePacket } from './codec.js';

/** The PUBLISH properties a broker sent. A property the broker left out is an absent key. */
export interface MessageProperties {
  payloadFormatIndicator?: 0 | 1;
  messageExpiryInterval?: number;
  contentType?: string;
  responseTopic?: string;
  correlationData?: Uint8Array;
  /** One identifier for each matching subscription, in wire order. */
  subscriptionIdentifiers?: readonly number[];
  /** Key and value pairs in wire order. A key can repeat. */
  userProperties?: readonly UserProperty[];
}

type WirePublish = Extract<WirePacket, { cmd: 'publish' }>;

/** Copy the properties of a decoded PUBLISH onto a message and return the message. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The function fills the message it is given, and decoded packets carry mutable byte views.
export function withMessageProperties<Message extends MessageProperties>(message: Message, packet: WirePublish): Message {
  if (packet.payloadFormatIndicator !== undefined) message.payloadFormatIndicator = packet.payloadFormatIndicator;
  if (packet.messageExpiryInterval !== undefined) message.messageExpiryInterval = packet.messageExpiryInterval;
  if (packet.contentType !== undefined) message.contentType = packet.contentType;
  if (packet.responseTopic !== undefined) message.responseTopic = packet.responseTopic;
  if (packet.correlationData !== undefined) message.correlationData = packet.correlationData;
  if (packet.subscriptionIdentifiers !== undefined) message.subscriptionIdentifiers = packet.subscriptionIdentifiers;
  if (packet.userProperties !== undefined) message.userProperties = packet.userProperties;
  return message;
}
