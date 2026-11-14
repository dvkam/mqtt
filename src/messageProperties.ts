import type { FramedPacket, UserProperty } from './wireCodec.js';

/** The PUBLISH properties a broker sent. A property the broker left out is an absent key. */
export interface MessageProperties<Bytes extends Uint8Array = Uint8Array> {
  payloadFormatIndicator?: 0 | 1;
  messageExpiryInterval?: number;
  contentType?: string;
  responseTopic?: string;
  correlationData?: Bytes;
  /** One identifier for each matching subscription, in wire order. */
  subscriptionIdentifiers?: readonly number[];
  /** Key and value pairs in wire order. A key can repeat. */
  userProperties?: readonly UserProperty[];
}

/** Read the properties of a decoded PUBLISH. `bytes` gives a byte field the platform's byte type. */
export function messageProperties<Bytes extends Uint8Array>(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Decoded packets carry mutable byte views that the message hands to the application.
  packet: Extract<FramedPacket, { cmd: 'publish' }>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The converter returns a view of the same mutable bytes.
  bytes: (value: Uint8Array) => Bytes,
): MessageProperties<Bytes> {
  const properties: MessageProperties<Bytes> = {};
  if (packet.payloadFormatIndicator !== undefined) properties.payloadFormatIndicator = packet.payloadFormatIndicator;
  if (packet.messageExpiryInterval !== undefined) properties.messageExpiryInterval = packet.messageExpiryInterval;
  if (packet.contentType !== undefined) properties.contentType = packet.contentType;
  if (packet.responseTopic !== undefined) properties.responseTopic = packet.responseTopic;
  if (packet.correlationData !== undefined) properties.correlationData = bytes(packet.correlationData);
  if (packet.subscriptionIdentifiers !== undefined) properties.subscriptionIdentifiers = packet.subscriptionIdentifiers;
  if (packet.userProperties !== undefined) properties.userProperties = packet.userProperties;
  return properties;
}
