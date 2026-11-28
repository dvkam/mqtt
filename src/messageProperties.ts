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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The message keeps the payload and Correlation Data of `packet` without a copy, and the application receives it as its own writable payload (the handlers in test/types/public-client-types.ts fill it). A read-only parameter type would be false for bytes that are handed on as writable.
  packet: Extract<FramedPacket, { cmd: 'publish' }>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `bytes` returns the memory of `value` as `Bytes`, and the application receives it as its own writable payload (the handlers in test/types/public-client-types.ts fill it). A read-only parameter type would be false for bytes that are handed on as writable.
  bytes: (value: Uint8Array) => Bytes,
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
