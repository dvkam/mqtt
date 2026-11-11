import { validateInboundTopic } from './inboundTopic.js';
import { ProtocolInputError } from './protocolInputError.js';
import { isSubscriptionReason } from './subscriptionReason.js';
import { isPubackReason } from './pubackReason.js';

export type UserProperty = readonly [key: string, value: string];
interface Properties {
  userProperties?: readonly UserProperty[];
}

type PublishFields = Properties & {
  cmd: 'publish';
  topic: string;
  payload: Uint8Array;
  retain?: boolean;
};

export type WirePacket =
  | (Properties & {
      cmd: 'connect';
      clientId: string;
      cleanStart?: boolean;
      keepAlive?: number;
      receiveMaximum?: number;
      username?: string;
      password?: Uint8Array;
    })
  | (Properties & {
      cmd: 'connack';
      sessionPresent: boolean;
      reasonCode: number;
      receiveMaximum?: number;
      maximumQoS?: number;
      topicAliasMaximum?: number;
    })
  | (PublishFields & ({ qos?: 0; messageId?: never; dup?: never } | { qos: 1; messageId: number; dup?: boolean }))
  | (Properties & { cmd: 'puback'; messageId: number; reasonCode: number; reasonString?: string })
  | (Properties & { cmd: 'subscribe'; messageId: number; topics: readonly string[]; qos?: 0 | 1 })
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
  | { cmd: 'disconnect'; reasonCode?: number }
  | { cmd: 'pingreq' | 'pingresp' };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const connackCodes = new Set([
  0, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 140, 144, 149, 151, 153, 154, 155, 156, 157, 159,
]);
const disconnectErrors = new Set([0x81, 0x82, 0x93, 0x94]);
const packetFields: Partial<Record<string, readonly string[]>> = {
  connect: ['cmd', 'clientId', 'cleanStart', 'keepAlive', 'receiveMaximum', 'username', 'password', 'userProperties'],
  connack: ['cmd', 'sessionPresent', 'reasonCode', 'receiveMaximum', 'maximumQoS', 'topicAliasMaximum', 'userProperties'],
  publish: ['cmd', 'topic', 'payload', 'retain', 'userProperties', 'qos', 'messageId', 'dup'],
  puback: ['cmd', 'messageId', 'reasonCode', 'reasonString', 'userProperties'],
  subscribe: ['cmd', 'messageId', 'topics', 'qos', 'userProperties'],
  suback: ['cmd', 'messageId', 'granted', 'reasonString', 'userProperties'],
  unsubscribe: ['cmd', 'messageId', 'topics', 'userProperties'],
  unsuback: ['cmd', 'messageId', 'granted', 'reasonString', 'userProperties'],
  pingreq: ['cmd'],
  pingresp: ['cmd'],
  disconnect: ['cmd', 'reasonCode'],
};

function integer(value: number, maximum: number, minimum = 0): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError('MQTT integer out of range');
  return value;
}

function uint16(value: number): Uint8Array<ArrayBuffer> {
  integer(value, 65_535);
  return Uint8Array.of(value >> 8, value & 255);
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

function utf8(value: string): Uint8Array<ArrayBuffer> {
  if (value.includes('\u0000') || /[\uD800-\uDFFF]/u.test(value)) throw new Error('Invalid MQTT UTF-8 string');
  const bytes = encoder.encode(value);
  return join([uint16(bytes.length), bytes]);
}

function topic(value: string, filter: boolean): void {
  if (filter && value.startsWith('$share/')) throw new Error('Unsupported shared subscription');
  if (!value || (!filter && /[+#]/u.test(value))) throw new Error('Invalid MQTT topic');
  if (
    filter &&
    value.split('/').some((level: string, index: number, levels: readonly string[]) => {
      return (level.includes('#') && (level !== '#' || index !== levels.length - 1)) || (level.includes('+') && level !== '+');
    })
  )
    throw new Error('Invalid MQTT topic filter');
}

function properties(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
  packet: Readonly<Exclude<WirePacket, { cmd: 'pingreq' | 'pingresp' | 'disconnect' }>>,
): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  for (const [key, value] of packet.userProperties ?? []) parts.push(Uint8Array.of(0x26), utf8(key), utf8(value));
  if ((packet.cmd === 'connect' || packet.cmd === 'connack') && packet.receiveMaximum !== undefined)
    parts.push(Uint8Array.of(0x21), uint16(integer(packet.receiveMaximum, 65_535, 1)));
  if (packet.cmd === 'connack') {
    if (packet.maximumQoS !== undefined) parts.push(Uint8Array.of(0x24, integer(packet.maximumQoS, 1)));
    if (packet.topicAliasMaximum !== undefined) parts.push(Uint8Array.of(0x22), uint16(packet.topicAliasMaximum));
  }
  if ((packet.cmd === 'suback' || packet.cmd === 'unsuback' || packet.cmd === 'puback') && packet.reasonString !== undefined)
    parts.push(Uint8Array.of(0x1f), utf8(packet.reasonString));
  const body = join(parts);
  return join([variable(body.length), body]);
}

/** MQTT 5 preview profile. Unsupported packet forms and properties are rejected. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
export function encodePacket(packet: Readonly<WirePacket>): Uint8Array<ArrayBuffer> {
  const fields = packetFields[packet.cmd];
  if (!fields || Object.keys(packet).some((field) => !fields.includes(field))) {
    throw new Error('Unsupported MQTT encoder field or packet');
  }
  let header: number;
  let body: Uint8Array;
  switch (packet.cmd) {
    case 'connect': {
      const flags =
        (packet.cleanStart === false ? 0 : 2) |
        (packet.username === undefined ? 0 : 128) |
        (packet.password === undefined ? 0 : 64);
      const parts = [
        utf8('MQTT'),
        Uint8Array.of(5, flags),
        uint16(packet.keepAlive ?? 0),
        properties(packet),
        utf8(packet.clientId),
      ];
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
      topic(packet.topic, false);
      header = 0x30 | (packet.retain === true ? 1 : 0);
      const { qos } = packet;
      integer(qos ?? 0, 1);
      if (qos === 1) header |= 2 | (packet.dup === true ? 8 : 0);
      else if ('messageId' in packet || 'dup' in packet) throw new Error('Unsupported QoS 0 PUBLISH field');
      const encodedTopic = utf8(packet.topic);
      const identifier = qos === 1 ? uint16(integer(packet.messageId, 65_535, 1)) : undefined;
      const encodedProperties = properties(packet);
      const payload = packet.payload;
      const remaining = encodedTopic.byteLength + (identifier?.byteLength ?? 0) + encodedProperties.byteLength + payload.byteLength;
      const remainingLength = variable(remaining);
      const frame = new Uint8Array(1 + remainingLength.byteLength + remaining);
      frame[0] = header;
      const fields = [remainingLength, encodedTopic];
      if (identifier) fields.push(identifier);
      fields.push(encodedProperties);
      let offset = 1;
      for (const field of fields) {
        frame.set(field, offset);
        offset += field.byteLength;
      }
      frame.set(payload, offset);
      return frame;
    }
    case 'puback': {
      const identifier = uint16(integer(packet.messageId, 65_535, 1));
      if (!isPubackReason(packet.reasonCode)) throw new Error('Invalid PUBACK reason code');
      header = 0x40;
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
      const subscriptionQos = packet.cmd === 'subscribe' ? integer(packet.qos ?? 0, 1) : 0;
      body = join([
        uint16(packet.messageId),
        properties(packet),
        ...packet.topics.map((value) => {
          topic(value, true);
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
    case 'disconnect':
      if (packet.reasonCode === undefined) return Uint8Array.of(0xe0, 0);
      if (disconnectErrors.has(packet.reasonCode)) return Uint8Array.of(0xe0, 1, packet.reasonCode);
      throw new Error('Unsupported DISCONNECT reason');
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
    return this.take(1)[0]!;
  }
  uint16(): number {
    return this.byte() * 256 + this.byte();
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
    const value = decoder.decode(this.take(this.uint16()));
    if (value.includes('\u0000')) throw new Error('Invalid MQTT UTF-8 string');
    return value;
  }
  end(): void {
    if (this.remaining !== 0) throw new Error('Trailing MQTT bytes');
  }
}

interface DecodedProperties extends Properties {
  topicAlias?: number;
  receiveMaximum?: number;
  maximumQoS?: number;
  topicAliasMaximum?: number;
  reasonString?: string;
}

function readProperties(reader: Readonly<Reader>, cmd: string): DecodedProperties {
  const fields = new Reader(reader.take(reader.variable()));
  const result: DecodedProperties = {};
  const userProperties: UserProperty[] = [];
  while (fields.remaining > 0) {
    const id = fields.variable();
    switch (id) {
      case 0x26:
        userProperties.push([fields.string(), fields.string()]);
        break;
      case 0x21:
        if ((cmd !== 'connect' && cmd !== 'connack') || result.receiveMaximum !== undefined)
          throw new Error('Invalid Receive Maximum property');
        result.receiveMaximum = integer(fields.uint16(), 65_535, 1);
        break;
      case 0x22:
        if (cmd !== 'connack' || result.topicAliasMaximum !== undefined) throw new Error('Invalid Topic Alias Maximum property');
        result.topicAliasMaximum = fields.uint16();
        break;
      case 0x23:
        if (cmd !== 'publish' || result.topicAlias !== undefined)
          throw new ProtocolInputError('Invalid MQTT Topic Alias property', 0x82);
        result.topicAlias = fields.uint16();
        break;
      case 0x24:
        if (cmd !== 'connack' || result.maximumQoS !== undefined) throw new Error('Invalid Maximum QoS property');
        result.maximumQoS = integer(fields.byte(), 1);
        break;
      case 0x1f:
        if ((cmd !== 'suback' && cmd !== 'unsuback' && cmd !== 'puback') || result.reasonString !== undefined)
          throw new Error('Invalid Reason String property');
        result.reasonString = fields.string();
        break;
      default:
        throw new Error('Unsupported MQTT property ' + id);
    }
  }
  if (userProperties.length > 0) result.userProperties = userProperties;
  return result;
}

function validateHeader(header: number): void {
  if (![0x10, 0x20, 0x30, 0x31, 0x32, 0x33, 0x3a, 0x3b, 0x40, 0x82, 0x90, 0xa2, 0xb0, 0xc0, 0xd0, 0xe0].includes(header)) {
    throw new Error('Unsupported MQTT packet or invalid fixed-header flags');
  }
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers; the codec preserves those input and output types.
function decodeFrame(frame: Readonly<Uint8Array>): WirePacket {
  const reader = new Reader(frame);
  const header = reader.byte();
  reader.variable();
  let packet: WirePacket;
  switch (header) {
    case 0x10: {
      if (reader.string() !== 'MQTT' || reader.byte() !== 5) throw new Error('Unsupported MQTT version');
      const flags = reader.byte();
      if ((flags & ~0xc2) !== 0) throw new Error('Unsupported CONNECT flags');
      const keepAlive = reader.uint16();
      const props = readProperties(reader, 'connect');
      packet = {
        cmd: 'connect',
        clientId: reader.string(),
        cleanStart: (flags & 2) !== 0,
        keepAlive,
        ...props,
      };
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
        ...readProperties(reader, 'connack'),
      };
      break;
    }
    case 0x30:
    case 0x31:
    case 0x32:
    case 0x33:
    case 0x3a:
    case 0x3b: {
      const name = reader.string();
      const messageId = (header & 2) === 0 ? undefined : integer(reader.uint16(), 65_535, 1);
      const { topicAlias, ...props } = readProperties(reader, 'publish');
      validateInboundTopic(name, topicAlias !== undefined);
      const fields = {
        cmd: 'publish' as const,
        topic: name,
        payload: reader.take(reader.remaining),
        retain: (header & 1) !== 0,
        ...props,
      };
      packet = messageId === undefined ? fields : { ...fields, qos: 1, messageId, dup: (header & 8) !== 0 };
      break;
    }
    case 0x40: {
      const messageId = integer(reader.uint16(), 65_535, 1);
      const reasonCode = reader.remaining === 0 ? 0 : reader.byte();
      if (!isPubackReason(reasonCode)) throw new Error('Invalid PUBACK reason code');
      const props = reader.remaining === 0 ? {} : readProperties(reader, 'puback');
      packet = { cmd: 'puback', messageId, reasonCode, ...props };
      break;
    }
    case 0x82:
    case 0xa2: {
      const cmd = header === 0x82 ? 'subscribe' : 'unsubscribe';
      const messageId = integer(reader.uint16(), 65_535, 1);
      const props = readProperties(reader, cmd);
      const topics = [];
      let qos: 0 | 1 | undefined;
      while (reader.remaining > 0) {
        const name = reader.string();
        topic(name, true);
        if (cmd === 'subscribe') {
          const options = reader.byte();
          if ((options !== 0 && options !== 1) || (qos !== undefined && options !== qos))
            throw new Error('Unsupported subscription options');
          qos = options;
        }
        topics.push(name);
      }
      if (topics.length === 0) throw new Error('Empty ' + cmd.toUpperCase());
      packet = cmd === 'subscribe' && qos === 1 ? { cmd, messageId, topics, qos, ...props } : { cmd, messageId, topics, ...props };
      break;
    }
    case 0x90:
    case 0xb0: {
      const cmd = header === 0x90 ? 'suback' : 'unsuback';
      const messageId = reader.uint16();
      if (messageId === 0) throw new ProtocolInputError('MQTT integer out of range', 0x82);
      const props = readProperties(reader, cmd);
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
    case 0xe0: {
      const reasonCode = reader.remaining > 0 ? reader.byte() : 0;
      if (reasonCode !== 0 && !disconnectErrors.has(reasonCode)) throw new Error('Unsupported DISCONNECT reason');
      if (reader.remaining > 0 && reader.variable() !== 0) throw new Error('Unsupported DISCONNECT properties');
      packet = reasonCode === 0 ? { cmd: 'disconnect' } : { cmd: 'disconnect', reasonCode };
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
