import type { MessageProperties } from './messageProperties.js';
import type { UserProperty } from './wireProperties.js';
import { isBytes } from './util/bytes.js';
import { validateMqttString, validateTopicName } from './util/validateTopic.js';

export interface WillMessage<Payload extends string | Uint8Array = Uint8Array> extends Omit<
  MessageProperties,
  'subscriptionIdentifiers'
> {
  topic: string;
  payload: Payload;
  qos?: 0 | 1 | 2;
  retain?: boolean;
  delayInterval?: number;
}

export type WillOptions = WillMessage<string | Uint8Array>;

const willEncoder = new TextEncoder();
const willDecoder = new TextDecoder('utf-8', { fatal: true });
const maxBinaryBytes = 65_535;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) ?? Uint8Array.prototype;
const arrayByteLength = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;

function copyBytes(value: unknown, field: string): Uint8Array<ArrayBuffer> {
  if (!isBytes(value)) throw new TypeError('MQTT Will ' + field + ' must be a Uint8Array');
  const length: unknown = arrayByteLength?.call(value);
  if (typeof length !== 'number' || length > maxBinaryBytes) throw new RangeError('MQTT Will ' + field + ' exceeds 65,535 bytes');
  return new Uint8Array(value);
}

function copyUserProperty(value: unknown): UserProperty {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError('Invalid MQTT Will User Property');
  const pair: readonly unknown[] = value;
  const [key, content] = pair;
  if (typeof key !== 'string' || typeof content !== 'string' || !validateMqttString(key) || !validateMqttString(content))
    throw new TypeError('Invalid MQTT Will User Property');
  return [key, content];
}

function optionalSeconds(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    throw new RangeError('Invalid MQTT Will ' + field);
  return value;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Validate the bounded Will payload without copying it again.
export function validateWillPayload(payload: Readonly<Uint8Array>, format: 0 | 1 | undefined): void {
  if (format !== 1) return;
  try {
    willDecoder.decode(payload);
  } catch {
    throw new Error('Invalid MQTT Will UTF-8 payload');
  }
}

type RuntimeWill = Readonly<Partial<Record<keyof WillOptions, unknown>>>;

/** Read each user-owned field once before validating and copying the values used on the wire. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The caller's byte views are mutable. The snapshot owns its copies.
export function captureWill(options: Readonly<WillOptions> | undefined, textPayload = true): WillMessage | undefined {
  if (options === undefined) return undefined;
  const input: RuntimeWill = options;
  const {
    topic,
    payload,
    qos,
    retain,
    delayInterval,
    messageExpiryInterval,
    payloadFormatIndicator,
    contentType,
    responseTopic,
    correlationData,
    userProperties,
    ...extraFields
  } = input;
  if (Object.keys(extraFields).length !== 0) throw new Error('Unsupported MQTT Will field');
  if (typeof topic !== 'string' || !validateTopicName(topic)) throw new Error('Invalid MQTT Will topic');
  if (qos !== undefined && qos !== 0 && qos !== 1 && qos !== 2) throw new RangeError('Invalid MQTT Will QoS');
  if (retain !== undefined && typeof retain !== 'boolean') throw new TypeError('Invalid MQTT Will Retain flag');
  if (payloadFormatIndicator !== undefined && payloadFormatIndicator !== 0 && payloadFormatIndicator !== 1)
    throw new RangeError('Invalid MQTT Will Payload Format Indicator');
  if (contentType !== undefined && (typeof contentType !== 'string' || !validateMqttString(contentType)))
    throw new TypeError('Invalid MQTT Will Content Type');
  if (responseTopic !== undefined && (typeof responseTopic !== 'string' || !validateTopicName(responseTopic)))
    throw new Error('Invalid MQTT Will Response Topic');
  if (textPayload && typeof payload === 'string' && payload.length > maxBinaryBytes)
    throw new RangeError('MQTT Will payload exceeds 65,535 bytes');
  const bytes = textPayload && typeof payload === 'string' ? willEncoder.encode(payload) : copyBytes(payload, 'payload');
  if (bytes.byteLength > maxBinaryBytes) throw new RangeError('MQTT Will payload exceeds 65,535 bytes');
  validateWillPayload(bytes, payloadFormatIndicator);
  if (userProperties !== undefined && !Array.isArray(userProperties)) throw new TypeError('Invalid MQTT Will User Properties');
  return {
    topic,
    payload: bytes,
    qos,
    retain,
    delayInterval: optionalSeconds(delayInterval, 'Delay Interval'),
    messageExpiryInterval: optionalSeconds(messageExpiryInterval, 'Message Expiry Interval'),
    payloadFormatIndicator,
    contentType,
    responseTopic,
    correlationData: correlationData === undefined ? undefined : copyBytes(correlationData, 'Correlation Data'),
    userProperties: userProperties === undefined ? undefined : Array.from(userProperties, copyUserProperty),
  };
}
