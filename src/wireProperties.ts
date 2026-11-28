import { ProtocolInputError } from './protocolInputError.js';
import type { ReadonlyBytes } from './util/bytes.js';

export type UserProperty = readonly [key: string, value: string];

/** The property fields of a decoded packet. A property the sender left out is an absent key. */
export interface DecodedProperties {
  userProperties?: UserProperty[];
  assignedClientIdentifier?: string;
  topicAlias?: number;
  receiveMaximum?: number;
  maximumQoS?: number;
  topicAliasMaximum?: number;
  reasonString?: string;
  payloadFormatIndicator?: 0 | 1;
  messageExpiryInterval?: number;
  contentType?: string;
  responseTopic?: string;
  correlationData?: Uint8Array;
  delayInterval?: number;
  subscriptionIdentifiers?: number[];
  sessionExpiryInterval?: number;
  serverKeepAlive?: number;
  authenticationMethod?: string;
  authenticationData?: Uint8Array;
  responseInformation?: string;
  serverReference?: string;
  retainAvailable?: boolean;
  maximumPacketSize?: number;
  wildcardSubscriptionAvailable?: boolean;
  subscriptionIdentifiersAvailable?: boolean;
  sharedSubscriptionAvailable?: boolean;
}

/** Each packet that carries a property section. The uppercase name appears in error messages. */
const kinds = {
  connect: 1,
  connack: 2,
  publish: 4,
  puback: 8,
  pubrec: 16,
  pubrel: 32,
  pubcomp: 64,
  subscribe: 128,
  suback: 256,
  unsubscribe: 512,
  unsuback: 1024,
  disconnect: 2048,
  will: 4096,
} as const;
export type PropertyKind = keyof typeof kinds;

/** A packet with a payload after its properties. Any other packet must end where its Property Length ends. */
const withPayload =
  kinds.connect | kinds.publish | kinds.subscribe | kinds.suback | kinds.unsubscribe | kinds.unsuback | kinds.will;
const acknowledgments = kinds.puback | kinds.pubrec | kinds.pubrel | kinds.pubcomp | kinds.suback | kinds.unsuback;
const everyKind = withPayload | acknowledgments | kinds.connack | kinds.disconnect;

/** The packets MQTT 5 section 2.2.2.2 assigns each property identifier to, within this codec's profile. */
const assignedKinds: Readonly<Record<number, number>> = {
  0x01: kinds.publish | kinds.will,
  0x02: kinds.publish | kinds.will,
  0x03: kinds.publish | kinds.will,
  0x08: kinds.publish | kinds.will,
  0x09: kinds.publish | kinds.will,
  0x0b: kinds.publish,
  0x11: kinds.connect | kinds.connack,
  0x12: kinds.connack,
  0x13: kinds.connack,
  0x15: kinds.connack,
  0x16: kinds.connack,
  0x18: kinds.will,
  0x1a: kinds.connack,
  0x1c: kinds.connack | kinds.disconnect,
  0x1f: kinds.connack | kinds.disconnect | acknowledgments,
  0x21: kinds.connect | kinds.connack,
  0x22: kinds.connack,
  0x23: kinds.publish,
  0x24: kinds.connack,
  0x25: kinds.connack,
  0x26: everyKind,
  0x27: kinds.connack,
  0x28: kinds.connack,
  0x29: kinds.connack,
  0x2a: kinds.connack,
};

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Longer ASCII strings decode faster through TextDecoder than by concatenation. */
const asciiFastPathBytes = 64;

/**
 * Decode an MQTT UTF-8 string (MQTT 5 section 1.5.4) from `bytes[start..end)`.
 * Returns undefined for ill-formed UTF-8 or U+0000. It never throws.
 */
export function decodeUtf8(bytes: ReadonlyBytes, start: number, end: number): string | undefined {
  if (end - start <= asciiFastPathBytes) {
    let text = '';
    let index = start;
    for (; index < end; index++) {
      const byte = bytes[index]!;
      // In well-formed UTF-8 a zero byte is always U+0000.
      if (byte === 0) return undefined;
      if (byte > 127) break;
      text += String.fromCharCode(byte);
    }
    if (index === end) return text;
  }
  let text: string;
  try {
    text = decoder.decode(bytes.subarray(start, end));
  } catch {
    return undefined;
  }
  return text.includes('\u0000') ? undefined : text;
}

/** An empty Response Topic or one with a wildcard is a protocol error (MQTT 5 section 3.3.2.3.5). */
export function responseTopic(value: string): string {
  if (value.length === 0 || value.includes('+') || value.includes('#'))
    throw new ProtocolInputError('Invalid MQTT Response Topic', 0x82);
  return value;
}

/** Reads one property section by index, so a scalar costs no allocation. */
class Section {
  offset: number;
  end: number;
  private readonly bytes: ReadonlyBytes;
  private readonly name: string;

  constructor(bytes: ReadonlyBytes, offset: number, name: string) {
    this.bytes = bytes;
    this.offset = offset;
    this.end = bytes.length;
    this.name = name;
  }

  private need(size: number): void {
    if (this.offset + size > this.end) throw new Error('Truncated MQTT ' + this.name + ' property');
  }

  byte(): number {
    this.need(1);
    return this.bytes[this.offset++]!;
  }

  flag(): 0 | 1 {
    const value = this.byte();
    if (value !== 0 && value !== 1) throw new Error('Invalid MQTT property value');
    return value;
  }

  uint16(): number {
    this.need(2);
    const value = this.bytes[this.offset]! * 256 + this.bytes[this.offset + 1]!;
    this.offset += 2;
    return value;
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
        if (index > 0 && value < 128 ** index) throw new Error('Non-canonical MQTT ' + this.name + ' property integer');
        return value;
      }
    }
    throw new Error('Malformed MQTT ' + this.name + ' property integer');
  }

  /** A view of the packet's bytes. It has the type of the input, so the Node decoder gets views of its own allocation. */
  binary(): Uint8Array {
    const size = this.uint16();
    this.need(size);
    const value = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }

  string(): string {
    const size = this.uint16();
    this.need(size);
    const value = decodeUtf8(this.bytes, this.offset, this.offset + size);
    if (value === undefined) throw new Error('Invalid MQTT ' + this.name + ' property UTF-8');
    this.offset += size;
    return value;
  }

  nonzero(value: number): number {
    if (value < 1) throw new Error('Invalid zero MQTT property value');
    return value;
  }

  duplicate(): Error {
    return new Error('Duplicate MQTT ' + this.name + ' property');
  }
}

export type PropertySection = Readonly<{ properties: DecodedProperties; end: number }>;

/**
 * Read the Property Length at `start` and the properties after it. `bytes.length` is the end of the packet.
 * `end` is the offset after the section. Every rule of MQTT 5 section 2.2.2 for this profile is checked here, once,
 * for the Node and the browser decoder.
 */
export function readProperties(bytes: ReadonlyBytes, start: number, kind: PropertyKind): PropertySection {
  const name = kind.toUpperCase();
  const bit = kinds[kind];
  const section = new Section(bytes, start, name);
  const length = section.variable();
  const end = section.offset + length;
  if (end > bytes.length || ((withPayload & bit) === 0 && end !== bytes.length))
    throw new Error('Invalid MQTT ' + name + ' property length');
  section.end = end;
  const properties: DecodedProperties = {};
  while (section.offset < end) {
    const identifier = section.variable();
    if (((assignedKinds[identifier] ?? 0) & bit) === 0) throw new Error('Invalid MQTT ' + name + ' property identifier');
    switch (identifier) {
      case 0x01:
        if (properties.payloadFormatIndicator !== undefined) throw section.duplicate();
        properties.payloadFormatIndicator = section.flag();
        break;
      case 0x02:
        if (properties.messageExpiryInterval !== undefined) throw section.duplicate();
        properties.messageExpiryInterval = section.uint32();
        break;
      case 0x03:
        if (properties.contentType !== undefined) throw section.duplicate();
        properties.contentType = section.string();
        break;
      case 0x08:
        if (properties.responseTopic !== undefined) throw section.duplicate();
        properties.responseTopic = responseTopic(section.string());
        break;
      case 0x09:
        if (properties.correlationData !== undefined) throw section.duplicate();
        properties.correlationData = section.binary();
        break;
      case 0x0b:
        (properties.subscriptionIdentifiers ??= []).push(section.nonzero(section.variable()));
        break;
      case 0x11:
        if (properties.sessionExpiryInterval !== undefined) throw section.duplicate();
        properties.sessionExpiryInterval = section.uint32();
        break;
      case 0x12:
        if (properties.assignedClientIdentifier !== undefined) throw section.duplicate();
        properties.assignedClientIdentifier = section.string();
        break;
      case 0x13:
        if (properties.serverKeepAlive !== undefined) throw section.duplicate();
        properties.serverKeepAlive = section.uint16();
        break;
      case 0x15:
        if (properties.authenticationMethod !== undefined) throw section.duplicate();
        properties.authenticationMethod = section.string();
        break;
      case 0x16:
        if (properties.authenticationData !== undefined) throw section.duplicate();
        properties.authenticationData = section.binary();
        break;
      case 0x18:
        if (properties.delayInterval !== undefined) throw section.duplicate();
        properties.delayInterval = section.uint32();
        break;
      case 0x1a:
        if (properties.responseInformation !== undefined) throw section.duplicate();
        properties.responseInformation = section.string();
        break;
      case 0x1c:
        if (properties.serverReference !== undefined) throw section.duplicate();
        properties.serverReference = section.string();
        break;
      case 0x1f:
        if (properties.reasonString !== undefined) throw section.duplicate();
        properties.reasonString = section.string();
        break;
      case 0x21:
        if (properties.receiveMaximum !== undefined) throw section.duplicate();
        properties.receiveMaximum = section.nonzero(section.uint16());
        break;
      case 0x22:
        if (properties.topicAliasMaximum !== undefined) throw section.duplicate();
        properties.topicAliasMaximum = section.uint16();
        break;
      case 0x23: {
        if (properties.topicAlias !== undefined) throw new ProtocolInputError('Duplicate MQTT Topic Alias property', 0x82);
        const alias = section.uint16();
        if (alias < 1) throw new ProtocolInputError('Invalid MQTT Topic Alias', 0x94);
        properties.topicAlias = alias;
        break;
      }
      case 0x24:
        if (properties.maximumQoS !== undefined) throw section.duplicate();
        properties.maximumQoS = section.flag();
        break;
      case 0x25:
        if (properties.retainAvailable !== undefined) throw section.duplicate();
        properties.retainAvailable = section.flag() === 1;
        break;
      case 0x26: {
        const key = section.string();
        (properties.userProperties ??= []).push([key, section.string()]);
        break;
      }
      case 0x27:
        if (properties.maximumPacketSize !== undefined) throw section.duplicate();
        properties.maximumPacketSize = section.nonzero(section.uint32());
        break;
      case 0x28:
        if (properties.wildcardSubscriptionAvailable !== undefined) throw section.duplicate();
        properties.wildcardSubscriptionAvailable = section.flag() === 1;
        break;
      case 0x29:
        if (properties.subscriptionIdentifiersAvailable !== undefined) throw section.duplicate();
        properties.subscriptionIdentifiersAvailable = section.flag() === 1;
        break;
      case 0x2a:
        if (properties.sharedSubscriptionAvailable !== undefined) throw section.duplicate();
        properties.sharedSubscriptionAvailable = section.flag() === 1;
        break;
      default:
        // assignedKinds lists exactly the identifiers handled above.
        throw new Error('Invalid MQTT ' + name + ' property identifier');
    }
  }
  return { properties, end };
}
