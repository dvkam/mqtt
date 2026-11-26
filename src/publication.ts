import { MqttError } from './mqttError.js';
import type { UserProperty } from './wireProperties.js';
import { isBytes, maxBinaryBytes, ownByteLength, variableByteIntegerSize } from './util/bytes.js';
import { loneSurrogate, utf8Length } from './util/utf8.js';
import { validateMqttString, validateTopicName } from './util/validateTopic.js';

/** The MQTT 5 properties and flags a caller can set on a PUBLISH. */
export interface PublishProperties {
  /** Ask the broker to keep the message for future subscribers. The broker must allow it in CONNACK. */
  retain?: boolean;
  /** 1 marks the payload as UTF-8 text. A byte payload is then checked before it is sent. */
  payloadFormatIndicator?: 0 | 1;
  /** Seconds the broker keeps the message for subscribers that have not received it, from 0 to 4,294,967,295. */
  messageExpiryInterval?: number;
  /** A description of the payload, such as a MIME type. */
  contentType?: string;
  /** The topic a responder publishes the reply to. */
  responseTopic?: string;
  /** Opaque bytes that tie a reply to its request, at most 65,535 bytes. */
  correlationData?: Uint8Array;
  /** Key and value pairs in the order to send them. A key can repeat. */
  userProperties?: readonly UserProperty[];
}

/** The properties a PUBLISH carries after validation. */
export interface PublicationProperties {
  readonly payloadFormatIndicator: 0 | 1 | undefined;
  readonly messageExpiryInterval: number | undefined;
  readonly contentType: string | undefined;
  readonly responseTopic: string | undefined;
  readonly correlationData: Uint8Array | undefined;
  readonly userProperties: readonly UserProperty[] | undefined;
}

/** A validated publication. The payload and Correlation Data are the caller's bytes, used as given. */
export interface OutgoingPublication {
  readonly topic: string;
  readonly payload: Uint8Array;
  readonly payloadBytes: number;
  readonly retain: boolean;
  /** Undefined when the caller set no property, so the PUBLISH packet carries no property keys. */
  readonly properties: PublicationProperties | undefined;
  /** Encoded property section, including its variable byte integer length. An empty section is one byte. */
  readonly propertyBytes: number;
}

type RuntimeOptions = Readonly<Partial<Record<keyof PublishProperties, unknown>>>;

const payloadEncoder = new TextEncoder();
const utf8Check = new TextDecoder('utf-8', { fatal: true });

function invalid(message: string): MqttError {
  return new MqttError('ERR_MQTT_INVALID_ARGUMENT', message);
}

function encodePayload(payload: unknown, maxBytes: number): Uint8Array {
  if (typeof payload === 'string') {
    if (loneSurrogate.test(payload)) throw invalid('MQTT publish payload is not well-formed UTF-16');
    // Each code unit encodes to at least one byte, so a longer string cannot pass admission.
    if (payload.length > maxBytes) throw new MqttError('ERR_MQTT_CAPACITY', 'MQTT publication capacity exceeded');
    return payloadEncoder.encode(payload);
  }
  if (!isBytes(payload)) throw invalid('MQTT publish payload must be a string or a Uint8Array');
  return payload;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !validateMqttString(value)) throw invalid('Invalid MQTT ' + name);
  return value;
}

function optionalUserProperties(value: unknown): UserProperty[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid('Invalid MQTT User Properties');
  const items: readonly unknown[] = value;
  const pairs: UserProperty[] = [];
  for (const item of items) {
    if (!Array.isArray(item) || item.length !== 2) throw invalid('Invalid MQTT User Property');
    const pair: readonly unknown[] = item;
    const [key, content] = pair;
    if (typeof key !== 'string' || typeof content !== 'string' || !validateMqttString(key) || !validateMqttString(content))
      throw invalid('Invalid MQTT User Property');
    pairs.push([key, content]);
  }
  return pairs;
}

function capturedProperties(options: RuntimeOptions): { properties: PublicationProperties | undefined; propertyBytes: number } {
  const { payloadFormatIndicator, messageExpiryInterval, contentType, responseTopic, correlationData, userProperties } = options;
  if (
    payloadFormatIndicator === undefined &&
    messageExpiryInterval === undefined &&
    contentType === undefined &&
    responseTopic === undefined &&
    correlationData === undefined &&
    userProperties === undefined
  )
    return { properties: undefined, propertyBytes: 1 };
  let size = 0;
  if (payloadFormatIndicator !== undefined) {
    if (payloadFormatIndicator !== 0 && payloadFormatIndicator !== 1) throw invalid('Invalid MQTT Payload Format Indicator');
    size += 2;
  }
  if (messageExpiryInterval !== undefined) {
    if (
      typeof messageExpiryInterval !== 'number' ||
      !Number.isInteger(messageExpiryInterval) ||
      messageExpiryInterval < 0 ||
      messageExpiryInterval > 0xffff_ffff
    )
      throw invalid('Invalid MQTT Message Expiry Interval');
    size += 5;
  }
  const content = optionalString(contentType, 'Content Type');
  if (content !== undefined) size += 3 + utf8Length(content);
  if (responseTopic !== undefined) {
    if (typeof responseTopic !== 'string' || !validateTopicName(responseTopic)) throw invalid('Invalid MQTT Response Topic');
    size += 3 + utf8Length(responseTopic);
  }
  if (correlationData !== undefined) {
    if (!isBytes(correlationData)) throw invalid('Invalid MQTT Correlation Data');
    const length = ownByteLength(correlationData);
    if (length > maxBinaryBytes) throw invalid('Invalid MQTT Correlation Data');
    size += 3 + length;
  }
  const pairs = optionalUserProperties(userProperties);
  for (const [key, value] of pairs ?? []) size += 5 + utf8Length(key) + utf8Length(value);
  return {
    properties: {
      payloadFormatIndicator,
      messageExpiryInterval,
      contentType: content,
      responseTopic,
      correlationData,
      userProperties: pairs,
    },
    propertyBytes: variableByteIntegerSize(size) + size,
  };
}

/**
 * Validate a publish call before admission, so that a bad argument rejects with ERR_MQTT_INVALID_ARGUMENT instead of
 * failing in the encoder, which would end the session. `maxBytes` is the publication byte limit.
 */
export function capturePublication(
  topic: string,
  payload: unknown,
  options: RuntimeOptions | undefined,
  retainAvailable: boolean,
  maxBytes: number,
): OutgoingPublication {
  const bytes = encodePayload(payload, maxBytes);
  const payloadBytes = ownByteLength(bytes);
  if (options === undefined) return { topic, payload: bytes, payloadBytes, retain: false, properties: undefined, propertyBytes: 1 };
  const { retain } = options;
  if (retain !== undefined && typeof retain !== 'boolean') throw invalid('Invalid MQTT retain flag');
  if (retain === true && !retainAvailable) throw invalid('Broker does not support retained messages');
  const { properties, propertyBytes } = capturedProperties(options);
  // A text payload is valid UTF-8 already. A byte payload marked as UTF-8 is checked once here.
  if (properties?.payloadFormatIndicator === 1 && typeof payload !== 'string') {
    try {
      utf8Check.decode(bytes);
    } catch {
      throw invalid('MQTT publish payload is not valid UTF-8');
    }
  }
  return { topic, payload: bytes, payloadBytes, retain: retain === true, properties, propertyBytes };
}
