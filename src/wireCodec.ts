import { validateInboundTopic } from './inboundTopic.js';
import { ProtocolInputError } from './protocolInputError.js';
import { isSubscriptionReason } from './subscriptionReason.js';
import { isAcknowledgmentReason } from './pubackReason.js';
import { captureWill, validateWillPayload, type WillMessage } from './will.js';
import { isBytes, ownByteLength, variableByteIntegerSize } from './util/bytes.js';
import { loneSurrogate, utf8Length } from './util/utf8.js';
import {
  decodeUtf8,
  readProperties,
  responseTopic,
  type DecodedProperties,
  type PropertyKind,
  type UserProperty,
} from './wireProperties.js';

export type { UserProperty } from './wireProperties.js';
interface Properties {
  userProperties?: readonly UserProperty[];
}

type PublishFields = Properties & {
  cmd: 'publish';
  topic: string;
  payload: Uint8Array;
  retain?: boolean;
  payloadFormatIndicator?: 0 | 1;
  messageExpiryInterval?: number;
  contentType?: string;
  responseTopic?: string;
  correlationData?: Uint8Array;
  subscriptionIdentifiers?: readonly number[];
};

/** PUBACK, and the three packets that follow a QoS 2 PUBLISH. They share one layout. */
type Acknowledgment<Command extends string> = Properties & {
  cmd: Command;
  messageId: number;
  reasonCode: number;
  reasonString?: string;
};

export type WirePacket =
  | (Properties & {
      cmd: 'connect';
      clientId: string;
      cleanStart?: boolean;
      keepAlive?: number;
      receiveMaximum?: number;
      sessionExpiryInterval?: number;
      username?: string;
      password?: Uint8Array;
      will?: WillMessage;
    })
  | (Properties & {
      cmd: 'connack';
      sessionPresent: boolean;
      reasonCode: number;
      receiveMaximum?: number;
      maximumQoS?: number;
      topicAliasMaximum?: number;
      assignedClientIdentifier?: string;
      sessionExpiryInterval?: number;
      serverKeepAlive?: number;
      authenticationMethod?: string;
      authenticationData?: Uint8Array;
      responseInformation?: string;
      serverReference?: string;
      reasonString?: string;
      retainAvailable?: boolean;
      maximumPacketSize?: number;
      wildcardSubscriptionAvailable?: boolean;
      subscriptionIdentifiersAvailable?: boolean;
      sharedSubscriptionAvailable?: boolean;
    })
  | (PublishFields & ({ qos?: 0; messageId?: never; dup?: never } | { qos: 1 | 2; messageId: number; dup?: boolean }))
  | Acknowledgment<'puback'>
  | Acknowledgment<'pubrec'>
  | Acknowledgment<'pubrel'>
  | Acknowledgment<'pubcomp'>
  | (Properties & { cmd: 'subscribe'; messageId: number; topics: readonly string[]; qos?: 0 | 1 | 2 })
  | (Properties & {
      cmd: 'suback';
      messageId: number;
      granted: readonly number[];
      reasonString?: string;
    })
  | (Properties & { cmd: 'unsubscribe'; messageId: number; topics: readonly string[] })
  | (Properties & {
      cmd: 'unsuback';
      messageId: number;
      granted: readonly number[];
      reasonString?: string;
    })
  | (Properties & { cmd: 'disconnect'; reasonCode?: number; reasonString?: string; serverReference?: string })
  | { cmd: 'pingreq' }
  | { cmd: 'pingresp' };

/**
 * A broker packet as `decodeFramedPacket` returns it for the clients. It adds AUTH and the Topic Alias, which the session
 * rejects. The public `mqtt/codec` entry does not export it.
 */
export type FramedPacket =
  | Exclude<WirePacket, { cmd: 'publish' }>
  | (Extract<WirePacket, { cmd: 'publish' }> & { topicAlias?: number })
  | { cmd: 'auth'; reasonCode: number };

/** The packets only a client sends. A broker that sends one breaks the direction rule in MQTT 5 section 2.1.2. */
export const clientOnlyCommands = [
  'connect',
  'subscribe',
  'unsubscribe',
  'pingreq',
] as const satisfies readonly WirePacket['cmd'][];

/** The packets only a broker sends. */
export const brokerOnlyCommands = ['connack', 'suback', 'unsuback', 'pingresp'] as const satisfies readonly WirePacket['cmd'][];
const clientOnly: ReadonlySet<string> = new Set(clientOnlyCommands);

/** Every packet a client may write. `encodePacket` accepts each member. */
export type ClientPacket = Exclude<WirePacket, { cmd: (typeof brokerOnlyCommands)[number] }>;

/** Every packet a broker may send inside the public codec profile. */
export type BrokerPacket = Exclude<WirePacket, { cmd: (typeof clientOnlyCommands)[number] }>;

export function isClientOnlyCommand(command: string): command is (typeof clientOnlyCommands)[number] {
  return clientOnly.has(command);
}

export function isClientOnlyPacket<Packet extends Readonly<{ cmd: string }>>(
  packet: Packet,
): packet is Extract<Packet, { cmd: (typeof clientOnlyCommands)[number] }> {
  return clientOnly.has(packet.cmd);
}

const encoder = new TextEncoder();
const connackCodes = new Set([
  0, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 140, 144, 149, 151, 153, 154, 155, 156, 157, 159,
]);
// MQTT 5 section 3.14.2.1. Zero is the normal disconnection and is encoded without a reason byte.
const disconnectReasons = new Set([
  0x04, 0x80, 0x81, 0x82, 0x83, 0x87, 0x89, 0x8b, 0x8d, 0x8e, 0x8f, 0x90, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b,
  0x9c, 0x9d, 0x9e, 0x9f, 0xa0, 0xa1, 0xa2,
]);
const acknowledgmentFields = ['cmd', 'messageId', 'reasonCode', 'reasonString', 'userProperties'];
const packetFields: Partial<Record<string, readonly string[]>> = {
  connect: [
    'cmd',
    'clientId',
    'cleanStart',
    'keepAlive',
    'receiveMaximum',
    'sessionExpiryInterval',
    'username',
    'password',
    'userProperties',
    'will',
  ],
  connack: [
    'cmd',
    'sessionPresent',
    'reasonCode',
    'receiveMaximum',
    'maximumQoS',
    'topicAliasMaximum',
    'assignedClientIdentifier',
    'sessionExpiryInterval',
    'serverKeepAlive',
    'authenticationMethod',
    'authenticationData',
    'responseInformation',
    'serverReference',
    'reasonString',
    'retainAvailable',
    'maximumPacketSize',
    'wildcardSubscriptionAvailable',
    'subscriptionIdentifiersAvailable',
    'sharedSubscriptionAvailable',
    'userProperties',
  ],
  publish: [
    'cmd',
    'topic',
    'payload',
    'retain',
    'userProperties',
    'qos',
    'messageId',
    'dup',
    'payloadFormatIndicator',
    'messageExpiryInterval',
    'contentType',
    'responseTopic',
    'correlationData',
    'subscriptionIdentifiers',
  ],
  puback: acknowledgmentFields,
  pubrec: acknowledgmentFields,
  pubrel: acknowledgmentFields,
  pubcomp: acknowledgmentFields,
  subscribe: ['cmd', 'messageId', 'topics', 'qos', 'userProperties'],
  suback: ['cmd', 'messageId', 'granted', 'reasonString', 'userProperties'],
  unsubscribe: ['cmd', 'messageId', 'topics', 'userProperties'],
  unsuback: ['cmd', 'messageId', 'granted', 'reasonString', 'userProperties'],
  pingreq: ['cmd'],
  pingresp: ['cmd'],
  disconnect: ['cmd', 'reasonCode', 'reasonString', 'serverReference', 'userProperties'],
};

function integer(value: number, maximum: number, minimum = 0): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError('MQTT integer out of range');
  return value;
}

function uint16(value: number): Uint8Array<ArrayBuffer> {
  integer(value, 65_535);
  return Uint8Array.of(value >> 8, value & 255);
}

function uint32(value: number, minimum = 0): Uint8Array<ArrayBuffer> {
  integer(value, 4_294_967_295, minimum);
  return Uint8Array.of(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
function binary(value: Readonly<Uint8Array>): Uint8Array<ArrayBuffer> {
  return join([uint16(value.byteLength), value]);
}

function variable(value: number): Uint8Array<ArrayBuffer> {
  integer(value, 268_435_455);
  const bytes = [];
  do {
    const digit = value % 128;
    value = Math.floor(value / 128);
    bytes.push(digit | (value > 0 ? 128 : 0));
  } while (value > 0);
  return Uint8Array.from(bytes);
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
function join(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function checkString(value: string): void {
  if (value.includes('\u0000') || loneSurrogate.test(value)) throw new Error('Invalid MQTT UTF-8 string');
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  checkString(value);
  const bytes = encoder.encode(value);
  return join([uint16(bytes.length), bytes]);
}

/** The encoded size of an MQTT UTF-8 string, including its two-byte length. */
function stringSize(value: string): number {
  checkString(value);
  return 2 + integer(utf8Length(value), 65_535);
}

function variableSize(value: number): number {
  return variableByteIntegerSize(integer(value, 268_435_455));
}

function binarySize(value: unknown, maximum: number): number {
  if (!isBytes(value)) throw new RangeError('Invalid MQTT binary data');
  return integer(ownByteLength(value), maximum);
}

const none: readonly never[] = [];

/** Writes one frame into a single allocation. The caller sizes the frame first and checks each value it writes. */
class FrameWriter {
  readonly frame: Uint8Array<ArrayBuffer>;
  offset = 0;

  constructor(size: number) {
    this.frame = new Uint8Array(size);
  }

  byte(value: number): void {
    this.frame[this.offset++] = value;
  }

  uint16(value: number): void {
    this.frame[this.offset++] = value >> 8;
    this.frame[this.offset++] = value & 255;
  }

  variable(value: number): void {
    do {
      const digit = value % 128;
      value = Math.floor(value / 128);
      this.frame[this.offset++] = digit | (value > 0 ? 128 : 0);
    } while (value > 0);
  }

  /** Writes a string that `stringSize` accepted. ASCII is written directly, which avoids a TextEncoder call per field. */
  string(value: string): void {
    const { frame } = this;
    const start = this.offset;
    let index = start + 2;
    for (let unit = 0; unit < value.length; unit++) {
      const code = value.charCodeAt(unit);
      if (code > 0x7f) {
        index += encoder.encodeInto(value.slice(unit), frame.subarray(index)).written;
        break;
      }
      frame[index++] = code;
    }
    const length = index - start - 2;
    frame[start] = length >> 8;
    frame[start + 1] = length & 255;
    this.offset = index;
  }

  /**
   * Copies a Uint8Array that `binarySize` measured. A Subscription Identifier getter runs after Correlation Data is sized
   * and can resize its buffer, so the length is compared again.
   */
  bytes(value: unknown, length: number): void {
    if (!isBytes(value) || ownByteLength(value) !== length) throw new RangeError('MQTT bytes changed during encoding');
    this.frame.set(value, this.offset);
    this.offset += length;
  }
}

function topic(value: string, filter: boolean, sharedSubscriptions = false): void {
  if (filter && value.startsWith('$share/')) {
    if (!sharedSubscriptions) throw new Error('Unsupported shared subscription');
    const [, shareName = '', ...levels] = value.split('/');
    if (shareName.length === 0 || /[+#]/u.test(shareName) || levels.length === 0 || levels.join('/').length === 0)
      throw new Error('Invalid MQTT shared subscription');
    value = levels.join('/');
  }
  if (!value || (!filter && /[+#]/u.test(value))) throw new Error('Invalid MQTT topic');
  if (
    filter &&
    value.split('/').some((level: string, index: number, levels: readonly string[]) => {
      return (level.includes('#') && (level !== '#' || index !== levels.length - 1)) || (level.includes('+') && level !== '+');
    })
  )
    throw new Error('Invalid MQTT topic filter');
}

type PublicationProperties = Pick<
  PublishFields,
  'payloadFormatIndicator' | 'messageExpiryInterval' | 'contentType' | 'responseTopic' | 'correlationData'
>;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Append encoded properties to the caller's list and preserve its byte views.
function appendPublicationProperties(parts: Uint8Array[], packet: Readonly<PublicationProperties>): void {
  if (packet.payloadFormatIndicator !== undefined) parts.push(Uint8Array.of(0x01, integer(packet.payloadFormatIndicator, 1)));
  if (packet.messageExpiryInterval !== undefined) parts.push(Uint8Array.of(0x02), uint32(packet.messageExpiryInterval));
  if (packet.contentType !== undefined) parts.push(Uint8Array.of(0x03), utf8(packet.contentType));
  if (packet.responseTopic !== undefined) parts.push(Uint8Array.of(0x08), utf8(responseTopic(packet.responseTopic)));
  if (packet.correlationData !== undefined) parts.push(Uint8Array.of(0x09), binary(packet.correlationData));
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The parts carry mutable encoded byte views.
function propertySection(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  // MQTT encodes an empty property section as one byte with value zero.
  if (parts.length === 0) return new Uint8Array(1);
  const body = join(parts);
  return join([variable(body.length), body]);
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Will payload and correlation data are byte views.
function encodeWill(will: Readonly<WillMessage>): Uint8Array<ArrayBuffer> {
  const payload = binary(will.payload);
  const parts: Uint8Array[] = [];
  for (const [key, value] of will.userProperties ?? []) parts.push(Uint8Array.of(0x26), utf8(key), utf8(value));
  if (will.delayInterval !== undefined) parts.push(Uint8Array.of(0x18), uint32(will.delayInterval));
  appendPublicationProperties(parts, will);
  return join([propertySection(parts), utf8(will.topic), payload]);
}

function properties(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
  packet: Readonly<Exclude<WirePacket, { cmd: 'pingreq' | 'pingresp' }>>,
): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  for (const [key, value] of packet.userProperties ?? []) parts.push(Uint8Array.of(0x26), utf8(key), utf8(value));
  if ((packet.cmd === 'connect' || packet.cmd === 'connack') && packet.receiveMaximum !== undefined)
    parts.push(Uint8Array.of(0x21), uint16(integer(packet.receiveMaximum, 65_535, 1)));
  if (packet.cmd === 'connect' && packet.sessionExpiryInterval !== undefined)
    parts.push(Uint8Array.of(0x11), uint32(packet.sessionExpiryInterval));
  if (packet.cmd === 'connack') {
    if (packet.assignedClientIdentifier !== undefined) parts.push(Uint8Array.of(0x12), utf8(packet.assignedClientIdentifier));
    if (packet.maximumQoS !== undefined) parts.push(Uint8Array.of(0x24, integer(packet.maximumQoS, 1)));
    if (packet.topicAliasMaximum !== undefined) parts.push(Uint8Array.of(0x22), uint16(packet.topicAliasMaximum));
    if (packet.sessionExpiryInterval !== undefined) parts.push(Uint8Array.of(0x11), uint32(packet.sessionExpiryInterval));
    if (packet.serverKeepAlive !== undefined) parts.push(Uint8Array.of(0x13), uint16(packet.serverKeepAlive));
    if (packet.authenticationMethod !== undefined) parts.push(Uint8Array.of(0x15), utf8(packet.authenticationMethod));
    if (packet.authenticationData !== undefined) parts.push(Uint8Array.of(0x16), binary(packet.authenticationData));
    if (packet.responseInformation !== undefined) parts.push(Uint8Array.of(0x1a), utf8(packet.responseInformation));
    if (packet.retainAvailable !== undefined) parts.push(Uint8Array.of(0x25, packet.retainAvailable ? 1 : 0));
    if (packet.maximumPacketSize !== undefined) parts.push(Uint8Array.of(0x27), uint32(packet.maximumPacketSize, 1));
    if (packet.wildcardSubscriptionAvailable !== undefined)
      parts.push(Uint8Array.of(0x28, packet.wildcardSubscriptionAvailable ? 1 : 0));
    if (packet.subscriptionIdentifiersAvailable !== undefined)
      parts.push(Uint8Array.of(0x29, packet.subscriptionIdentifiersAvailable ? 1 : 0));
    if (packet.sharedSubscriptionAvailable !== undefined)
      parts.push(Uint8Array.of(0x2a, packet.sharedSubscriptionAvailable ? 1 : 0));
  }
  if ((packet.cmd === 'connack' || packet.cmd === 'disconnect') && packet.serverReference !== undefined)
    parts.push(Uint8Array.of(0x1c), utf8(packet.serverReference));
  if (
    (packet.cmd === 'suback' ||
      packet.cmd === 'unsuback' ||
      packet.cmd === 'puback' ||
      packet.cmd === 'pubrec' ||
      packet.cmd === 'pubrel' ||
      packet.cmd === 'pubcomp' ||
      packet.cmd === 'connack' ||
      packet.cmd === 'disconnect') &&
    packet.reasonString !== undefined
  )
    parts.push(Uint8Array.of(0x1f), utf8(packet.reasonString));
  return propertySection(parts);
}

/** MQTT 5 preview profile. Unsupported packet forms and properties are rejected. */
export function encodePacket(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
  packet: Readonly<WirePacket>,
  { sharedSubscriptions = false }: Readonly<{ sharedSubscriptions?: boolean }> = {},
): Uint8Array<ArrayBuffer> {
  const fields = packetFields[packet.cmd];
  if (!fields || Object.keys(packet).some((field) => !fields.includes(field))) {
    throw new Error('Unsupported MQTT encoder field or packet');
  }
  let header: number;
  let body: Uint8Array;
  switch (packet.cmd) {
    case 'connect': {
      const will = captureWill(packet.will, false);
      const willFlags = will === undefined ? 0 : 4 | ((will.qos ?? 0) << 3) | (will.retain === true ? 32 : 0);
      const flags =
        (packet.cleanStart === false ? 0 : 2) |
        (packet.username === undefined ? 0 : 128) |
        (packet.password === undefined ? 0 : 64) |
        willFlags;
      const parts = [
        utf8('MQTT'),
        Uint8Array.of(5, flags),
        uint16(packet.keepAlive ?? 0),
        properties(packet),
        utf8(packet.clientId),
      ];
      if (will !== undefined) parts.push(encodeWill(will));
      if (packet.username !== undefined) parts.push(utf8(packet.username));
      if (packet.password !== undefined) parts.push(join([uint16(packet.password.length), packet.password]));
      header = 0x10;
      body = join(parts);
      break;
    }
    case 'connack':
      if (!connackCodes.has(packet.reasonCode) || (packet.reasonCode !== 0 && packet.sessionPresent))
        throw new Error('Invalid CONNACK');
      header = 0x20;
      body = join([Uint8Array.of(packet.sessionPresent ? 1 : 0, packet.reasonCode), properties(packet)]);
      break;
    case 'publish': {
      // Every field and User Property is read once. The checks and the writes use those values, and the frame is allocated
      // once.
      const {
        topic: name,
        qos,
        dup,
        retain,
        payload,
        userProperties: pairs,
        payloadFormatIndicator,
        messageExpiryInterval,
        contentType,
        responseTopic: replyTopic,
        correlationData,
        subscriptionIdentifiers: identifiersIn,
      } = packet;
      topic(name, false);
      header = 0x30 | (retain === true ? 1 : 0);
      integer(qos ?? 0, 2);
      if (qos === 1 || qos === 2) header |= (qos << 1) | (dup === true ? 8 : 0);
      else if ('messageId' in packet || 'dup' in packet) throw new Error('Unsupported QoS 0 PUBLISH field');
      const topicSize = stringSize(name);
      const messageId = qos === 1 || qos === 2 ? integer(packet.messageId, 65_535, 1) : undefined;
      let propertySize = 0;
      // Key, value, key, value. Allocated only when the packet has User Properties. `??` treats a null from a JavaScript
      // caller as empty, as the other packets do.
      let strings: string[] | undefined;
      for (const [key, value] of pairs ?? none) {
        propertySize += 1 + stringSize(key) + stringSize(value);
        (strings ??= []).push(key, value);
      }
      if (payloadFormatIndicator !== undefined) {
        integer(payloadFormatIndicator, 1);
        propertySize += 2;
      }
      if (messageExpiryInterval !== undefined) {
        integer(messageExpiryInterval, 4_294_967_295);
        propertySize += 5;
      }
      if (contentType !== undefined) propertySize += 1 + stringSize(contentType);
      const reply = replyTopic === undefined ? undefined : responseTopic(replyTopic);
      if (reply !== undefined) propertySize += 1 + stringSize(reply);
      const correlationSize = correlationData === undefined ? 0 : binarySize(correlationData, 65_535);
      if (correlationData !== undefined) propertySize += 3 + correlationSize;
      let identifiers: number[] | undefined;
      for (const identifier of identifiersIn ?? none) {
        propertySize += 1 + variableSize(integer(identifier, 268_435_455, 1));
        (identifiers ??= []).push(identifier);
      }
      const payloadSize = binarySize(payload, 268_435_455);
      const remaining = topicSize + (messageId === undefined ? 0 : 2) + variableSize(propertySize) + propertySize + payloadSize;
      const writer = new FrameWriter(1 + variableSize(remaining) + remaining);
      writer.byte(header);
      writer.variable(remaining);
      writer.string(name);
      if (messageId !== undefined) writer.uint16(messageId);
      writer.variable(propertySize);
      for (let index = 0; index < (strings?.length ?? 0); index += 2) {
        writer.byte(0x26);
        writer.string(strings?.[index] ?? '');
        writer.string(strings?.[index + 1] ?? '');
      }
      if (payloadFormatIndicator !== undefined) {
        writer.byte(0x01);
        writer.byte(payloadFormatIndicator);
      }
      if (messageExpiryInterval !== undefined) {
        writer.byte(0x02);
        writer.uint16(Math.floor(messageExpiryInterval / 65_536));
        writer.uint16(messageExpiryInterval % 65_536);
      }
      if (contentType !== undefined) {
        writer.byte(0x03);
        writer.string(contentType);
      }
      if (reply !== undefined) {
        writer.byte(0x08);
        writer.string(reply);
      }
      if (correlationData !== undefined) {
        writer.byte(0x09);
        writer.uint16(correlationSize);
        writer.bytes(correlationData, correlationSize);
      }
      for (const identifier of identifiers ?? none) {
        writer.byte(0x0b);
        writer.variable(identifier);
      }
      writer.bytes(payload, payloadSize);
      return writer.frame;
    }
    case 'puback':
    case 'pubrec':
    case 'pubrel':
    case 'pubcomp': {
      const { cmd, reasonCode } = packet;
      const identifier = uint16(integer(packet.messageId, 65_535, 1));
      if (!isAcknowledgmentReason(cmd, reasonCode)) throw new Error('Invalid ' + cmd.toUpperCase() + ' reason code');
      header = cmd === 'puback' ? 0x40 : cmd === 'pubrec' ? 0x50 : cmd === 'pubrel' ? 0x62 : 0x70;
      const encodedProperties = properties(packet);
      if (encodedProperties.length > 1) body = join([identifier, Uint8Array.of(packet.reasonCode), encodedProperties]);
      else body = packet.reasonCode === 0 ? identifier : join([identifier, Uint8Array.of(packet.reasonCode)]);
      break;
    }
    case 'subscribe':
    case 'unsubscribe':
      integer(packet.messageId, 65_535, 1);
      if (packet.topics.length === 0) throw new Error('Empty ' + packet.cmd.toUpperCase());
      header = packet.cmd === 'subscribe' ? 0x82 : 0xa2;
      const subscriptionQos = packet.cmd === 'subscribe' ? integer(packet.qos ?? 0, 2) : 0;
      body = join([
        uint16(packet.messageId),
        properties(packet),
        ...packet.topics.map((value) => {
          topic(value, true, sharedSubscriptions);
          const filter = utf8(value);
          return packet.cmd === 'subscribe' ? join([filter, Uint8Array.of(subscriptionQos)]) : filter;
        }),
      ]);
      break;
    case 'suback':
    case 'unsuback': {
      integer(packet.messageId, 65_535, 1);
      if (packet.granted.length === 0 || packet.granted.some((code) => !isSubscriptionReason(packet.cmd, code)))
        throw new Error('Invalid ' + packet.cmd.toUpperCase());
      header = packet.cmd === 'suback' ? 0x90 : 0xb0;
      body = join([uint16(packet.messageId), properties(packet), Uint8Array.from(packet.granted)]);
      break;
    }
    case 'pingreq':
      return Uint8Array.of(0xc0, 0);
    case 'pingresp':
      return Uint8Array.of(0xd0, 0);
    case 'disconnect': {
      const reasonCode = packet.reasonCode ?? 0;
      if (reasonCode !== 0 && !disconnectReasons.has(reasonCode)) throw new Error('Invalid DISCONNECT reason code');
      const encodedProperties = properties(packet);
      if (encodedProperties.length > 1)
        return join([Uint8Array.of(0xe0), variable(1 + encodedProperties.length), Uint8Array.of(reasonCode), encodedProperties]);
      return reasonCode === 0 ? Uint8Array.of(0xe0, 0) : Uint8Array.of(0xe0, 1, reasonCode);
    }
  }
  return join([Uint8Array.of(header), variable(body.length), body]);
}

class Reader {
  private readonly bytes: Uint8Array;
  offset = 0;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
  constructor(bytes: Readonly<Uint8Array>) {
    this.bytes = bytes;
  }
  get remaining(): number {
    return this.bytes.length - this.offset;
  }
  take(size: number): Uint8Array {
    if (size > this.remaining) throw new Error('Truncated MQTT field');
    const value = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
  byte(): number {
    if (this.offset >= this.bytes.length) throw new Error('Truncated MQTT field');
    return this.bytes[this.offset++]!;
  }
  uint16(): number {
    return this.byte() * 256 + this.byte();
  }
  uint32(): number {
    return this.uint16() * 65_536 + this.uint16();
  }
  variable(): number {
    let value = 0;
    for (let index = 0; index < 4; index++) {
      const digit = this.byte();
      value += (digit & 127) * 128 ** index;
      if ((digit & 128) === 0) {
        if (index > 0 && value < 128 ** index) throw new Error('Non-canonical MQTT variable integer');
        return value;
      }
    }
    throw new Error('Malformed MQTT variable integer');
  }
  string(): string {
    const size = this.uint16();
    if (size > this.remaining) throw new Error('Truncated MQTT field');
    const value = decodeUtf8(this.bytes, this.offset, this.offset + size);
    if (value === undefined) throw new Error('Invalid MQTT UTF-8 string');
    this.offset += size;
    return value;
  }
  /** The PUBLISH Topic Name, with the messages the Node decoder has always reported for it. */
  publishTopic(): string {
    if (this.remaining < 2) throw new Error('Truncated MQTT PUBLISH topic');
    const size = this.uint16();
    if (size > this.remaining) throw new Error('Truncated MQTT PUBLISH topic');
    const value = decodeUtf8(this.bytes, this.offset, this.offset + size);
    if (value === undefined) throw new Error('Invalid MQTT PUBLISH topic UTF-8');
    this.offset += size;
    return value;
  }
  /** Read the property section at the current offset. See readProperties for the checks. */
  properties(kind: PropertyKind): DecodedProperties {
    const section = readProperties(this.bytes, this.offset, kind);
    this.offset = section.end;
    return section.properties;
  }
  end(): void {
    if (this.remaining !== 0) throw new Error('Trailing MQTT bytes');
  }
}

const publicHeaders: ReadonlySet<number> = new Set([
  0x10, 0x20, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x3a, 0x3b, 0x3c, 0x3d, 0x40, 0x50, 0x62, 0x70, 0x82, 0x90, 0xa2, 0xb0, 0xc0,
  0xd0, 0xe0,
]);

function validateHeader(header: number): void {
  if (!publicHeaders.has(header)) {
    throw new Error('Unsupported MQTT packet or invalid fixed-header flags');
  }
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
function decodeFrame(frame: Readonly<Uint8Array>): WirePacket {
  const reader = new Reader(frame);
  const header = reader.byte();
  reader.variable();
  const packet = decodeBody(header, reader, true);
  // validateHeader already rejects the fixed headers outside the public profile. The guard narrows the type.
  if (!inPublicProfile(packet)) throw new Error('Unsupported MQTT packet or invalid fixed-header flags');
  return packet;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
function inPublicProfile(packet: FramedPacket): packet is WirePacket {
  return packet.cmd !== 'auth';
}

/**
 * Decode one packet from its fixed-header byte and the bytes that follow it, starting at the Remaining Length.
 * The caller owns the fixed-header checks, the direction check and the Topic Alias policy.
 */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
export function decodeFramedPacket(header: number, lengthAndBody: Readonly<Uint8Array>): FramedPacket {
  const reader = new Reader(lengthAndBody);
  reader.variable();
  return decodeBody(header, reader, false);
}

/** Read a packet identifier. MQTT-2.2.1-3 forbids zero, which is a protocol error. */
function packetIdentifier(reader: Readonly<Reader>): number {
  const messageId = reader.uint16();
  if (messageId === 0) throw new ProtocolInputError('MQTT integer out of range', 0x82);
  return messageId;
}

function decodeBody(header: number, reader: Readonly<Reader>, checkInboundTopic: boolean): FramedPacket {
  let packet: FramedPacket;
  switch (header) {
    case 0x10: {
      if (reader.string() !== 'MQTT' || reader.byte() !== 5) throw new Error('Unsupported MQTT version');
      const flags = reader.byte();
      const hasWill = (flags & 4) !== 0;
      const willQos = (flags >> 3) & 3;
      if ((flags & 1) !== 0 || ((flags & 0x38) !== 0 && !hasWill) || willQos === 3) throw new Error('Unsupported CONNECT flags');
      const keepAlive = reader.uint16();
      const props = reader.properties('connect');
      packet = {
        cmd: 'connect',
        clientId: reader.string(),
        cleanStart: (flags & 2) !== 0,
        keepAlive,
        ...props,
      };
      if (hasWill) {
        const willProps = reader.properties('will');
        const willTopic = reader.string();
        topic(willTopic, false);
        const payload = reader.take(reader.uint16());
        validateWillPayload(payload, willProps.payloadFormatIndicator);
        packet.will = {
          topic: willTopic,
          payload,
          qos: willQos === 2 ? 2 : willQos === 1 ? 1 : 0,
          retain: (flags & 32) !== 0,
          ...willProps,
        };
      }
      if (flags & 128) packet.username = reader.string();
      if (flags & 64) packet.password = reader.take(reader.uint16());
      break;
    }
    case 0x20: {
      const flags = reader.byte();
      const reasonCode = reader.byte();
      if (flags > 1 || !connackCodes.has(reasonCode) || (reasonCode !== 0 && flags !== 0)) throw new Error('Invalid CONNACK');
      packet = {
        cmd: 'connack',
        sessionPresent: flags === 1,
        reasonCode,
        ...reader.properties('connack'),
      };
      break;
    }
    case 0x30:
    case 0x31:
    case 0x32:
    case 0x33:
    case 0x3a:
    case 0x3b:
    case 0x34:
    case 0x35:
    case 0x3c:
    case 0x3d: {
      const name = reader.publishTopic();
      const messageId = (header & 6) === 0 ? undefined : packetIdentifier(reader);
      const props = reader.properties('publish');
      // The public decoder rejects any Topic Alias here. The framed decode leaves that policy to its caller.
      if (checkInboundTopic) validateInboundTopic(name, props.topicAlias !== undefined);
      const fields = {
        cmd: 'publish' as const,
        topic: name,
        payload: reader.take(reader.remaining),
        retain: (header & 1) !== 0,
        ...props,
      };
      packet =
        messageId === undefined ? fields : { ...fields, qos: (header & 4) === 0 ? 1 : 2, messageId, dup: (header & 8) !== 0 };
      break;
    }
    case 0x40: {
      const messageId = packetIdentifier(reader);
      const reasonCode = reader.remaining === 0 ? 0 : reader.byte();
      if (!isAcknowledgmentReason('puback', reasonCode)) throw new Error('Invalid PUBACK reason code');
      const props = reader.remaining === 0 ? {} : reader.properties('puback');
      packet = { cmd: 'puback', messageId, reasonCode, ...props };
      break;
    }
    case 0x82:
    case 0xa2: {
      const cmd = header === 0x82 ? 'subscribe' : 'unsubscribe';
      const messageId = packetIdentifier(reader);
      const props = reader.properties(cmd);
      const topics = [];
      let qos: 0 | 1 | 2 | undefined;
      while (reader.remaining > 0) {
        const name = reader.string();
        topic(name, true);
        if (cmd === 'subscribe') {
          const options = reader.byte();
          if ((options !== 0 && options !== 1 && options !== 2) || (qos !== undefined && options !== qos))
            throw new Error('Unsupported subscription options');
          qos = options;
        }
        topics.push(name);
      }
      if (topics.length === 0) throw new Error('Empty ' + cmd.toUpperCase());
      packet =
        cmd === 'subscribe' && qos !== undefined && qos !== 0
          ? { cmd, messageId, topics, qos, ...props }
          : { cmd, messageId, topics, ...props };
      break;
    }
    case 0x90:
    case 0xb0: {
      const cmd = header === 0x90 ? 'suback' : 'unsuback';
      const messageId = packetIdentifier(reader);
      const props = reader.properties(cmd);
      const granted = Array.from(reader.take(reader.remaining));
      if (granted.length === 0) throw new ProtocolInputError('Invalid ' + cmd.toUpperCase(), 0x81);
      if (granted.some((code) => !isSubscriptionReason(cmd, code)))
        throw new ProtocolInputError('Invalid ' + cmd.toUpperCase(), 0x82);
      packet = { cmd, messageId, granted, ...props };
      break;
    }
    case 0xc0:
      packet = { cmd: 'pingreq' };
      break;
    case 0xd0:
      packet = { cmd: 'pingresp' };
      break;
    case 0x50:
    case 0x62:
    case 0x70: {
      const cmd = header === 0x50 ? 'pubrec' : header === 0x62 ? 'pubrel' : 'pubcomp';
      const messageId = packetIdentifier(reader);
      const reasonCode = reader.remaining === 0 ? 0 : reader.byte();
      if (!isAcknowledgmentReason(cmd, reasonCode)) throw new Error('Invalid ' + cmd.toUpperCase() + ' reason code');
      const props = reader.remaining === 0 ? {} : reader.properties(cmd);
      packet = { cmd, messageId, reasonCode, ...props };
      break;
    }
    case 0xf0: {
      const reasonCode = reader.remaining === 0 ? 0 : reader.byte();
      if (reasonCode !== 0 && reasonCode !== 0x18 && reasonCode !== 0x19) throw new Error('Invalid AUTH reason code');
      reader.take(reader.remaining);
      packet = { cmd: 'auth', reasonCode };
      break;
    }
    case 0xe0: {
      const reasonCode = reader.remaining > 0 ? reader.byte() : 0;
      if (reasonCode !== 0 && !disconnectReasons.has(reasonCode)) throw new Error('Invalid DISCONNECT reason code');
      const props = reader.remaining > 0 ? reader.properties('disconnect') : {};
      packet = reasonCode === 0 ? { cmd: 'disconnect', ...props } : { cmd: 'disconnect', reasonCode, ...props };
      break;
    }
    default:
      throw new Error('Unsupported MQTT packet');
  }
  reader.end();
  return packet;
}

type PacketBytes = Readonly<Pick<Uint8Array, 'length' | 'subarray'>> & { readonly [index: number]: number };
type PacketBatch = WirePacket[] | { packets: WirePacket[]; error: Error };

/** Incremental, fail-closed decoder with a per-packet allocation limit. */
export class PacketDecoder {
  private readonly maxPacketBytes: number;
  private header: number[] = [];
  private frame: Uint8Array<ArrayBuffer> | undefined;
  private offset = 0;
  private failure: Error | undefined;
  private ended = false;
  constructor({ maxPacketBytes = 1024 * 1024 }: Readonly<{ maxPacketBytes?: number }> = {}) {
    this.maxPacketBytes = integer(maxPacketBytes, 268_435_460, 2);
  }
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
  push(bytes: Readonly<Uint8Array>): WirePacket[] {
    const batch = this.pushBatch(bytes);
    if (!Array.isArray(batch)) throw batch.error;
    return batch;
  }

  /** Retain complete packets before an error so a transport can deliver them in wire order. */
  pushBatch(bytes: PacketBytes): PacketBatch {
    if (this.failure) return { packets: [], error: this.failure };
    if (this.ended) return { packets: [], error: new Error('MQTT decoder has ended') };
    const packets: WirePacket[] = [];
    let index = 0;
    try {
      while (index < bytes.length) {
        if (!this.frame) {
          const digit = bytes[index++]!;
          this.header.push(digit);
          if (this.header.length === 1) {
            validateHeader(digit);
            continue;
          }
          if (digit & 128) {
            if (this.header.length === 5) throw new Error('Malformed MQTT Remaining Length');
            continue;
          }
          const size = new Reader(Uint8Array.from(this.header.slice(1))).variable() + this.header.length;
          if (size > this.maxPacketBytes) throw new Error('MQTT packet allocation limit exceeded');
          this.frame = new Uint8Array(size);
          this.frame.set(this.header);
          this.offset = this.header.length;
          this.header = [];
        }
        const size = Math.min(this.frame.length - this.offset, bytes.length - index);
        this.frame.set(bytes.subarray(index, index + size), this.offset);
        index += size;
        this.offset += size;
        if (this.offset === this.frame.length) {
          const frame = this.frame;
          this.frame = undefined;
          packets.push(decodeFrame(frame));
        }
      }
      return packets;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error('MQTT decode failed');
      this.frame = undefined;
      this.header = [];
      return { packets, error: this.failure };
    }
  }

  /** Validate end of input and permanently close this decoder. */
  finish(): void {
    if (this.failure) throw this.failure;
    if (this.header.length > 0 || this.frame !== undefined) {
      this.failure = new Error('Truncated MQTT packet at end of input');
      this.frame = undefined;
      this.header = [];
      this.offset = 0;
      throw this.failure;
    }
    this.ended = true;
  }
}
