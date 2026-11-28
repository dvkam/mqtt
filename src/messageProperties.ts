import type { FramedPacket, UserProperty } from './wireCodec.js';
import type { ReadonlyBytes, ReadonlyDeep } from './util/bytes.js';

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

/** A received QoS 0 PUBLISH. `Bytes` is `Buffer` on Node and `Uint8Array` in the browser. */
export interface PublishMessage<Bytes extends Uint8Array = Uint8Array> extends MessageProperties<Bytes> {
  cmd: 'publish';
  topic: string;
  payload: Bytes;
  qos: 0;
  dup: false;
  retain: boolean;
}

/** Build the received message for a decoded PUBLISH. A QoS 1 caller adds `qos`, `messageId` and `dup`. */
export function publishMessage<Bytes extends Uint8Array>(
  packet: ReadonlyDeep<Extract<FramedPacket, { cmd: 'publish' }>>,
  bytes: (value: ReadonlyBytes) => Bytes,
): PublishMessage<Bytes> {
  const message: PublishMessage<Bytes> = {
    cmd: 'publish',
    topic: packet.topic,
    payload: bytes(packet.payload),
    qos: 0,
    dup: false,
    retain: packet.retain ?? false,
  };
  if (packet.payloadFormatIndicator !== undefined) message.payloadFormatIndicator = packet.payloadFormatIndicator;
  if (packet.messageExpiryInterval !== undefined) message.messageExpiryInterval = packet.messageExpiryInterval;
  if (packet.contentType !== undefined) message.contentType = packet.contentType;
  if (packet.responseTopic !== undefined) message.responseTopic = packet.responseTopic;
  if (packet.correlationData !== undefined) message.correlationData = bytes(packet.correlationData);
  if (packet.subscriptionIdentifiers !== undefined) message.subscriptionIdentifiers = packet.subscriptionIdentifiers;
  if (packet.userProperties !== undefined) message.userProperties = packet.userProperties;
  return message;
}
