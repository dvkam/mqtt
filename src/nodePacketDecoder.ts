import { isUtf8 } from 'node:buffer';
import { parser, type Packet } from 'mqtt-packet';
import { ProtocolInputError } from './protocolInputError.ts';

type PropertyShape = 'byte' | 'two' | 'four' | 'variable' | 'string' | 'pair' | 'binary';
const connackProperties: Readonly<Record<number, PropertyShape>> = {
  0x11: 'four',
  0x12: 'string',
  0x13: 'two',
  0x15: 'string',
  0x16: 'binary',
  0x1a: 'string',
  0x1c: 'string',
  0x1f: 'string',
  0x21: 'two',
  0x22: 'two',
  0x24: 'byte',
  0x25: 'byte',
  0x26: 'pair',
  0x27: 'four',
  0x28: 'byte',
  0x29: 'byte',
  0x2a: 'byte',
};
const publishProperties: Readonly<Record<number, PropertyShape>> = {
  0x01: 'byte',
  0x02: 'four',
  0x03: 'string',
  0x08: 'string',
  0x09: 'binary',
  0x0b: 'variable',
  0x23: 'two',
  0x26: 'pair',
};

type AcknowledgmentKind = 'PUBACK' | 'PUBREC' | 'PUBREL' | 'PUBCOMP' | 'SUBACK' | 'UNSUBACK';
const acknowledgmentKinds: Readonly<Record<number, AcknowledgmentKind>> = {
  4: 'PUBACK',
  5: 'PUBREC',
  6: 'PUBREL',
  7: 'PUBCOMP',
  9: 'SUBACK',
  11: 'UNSUBACK',
};
const acknowledgmentProperties: Readonly<Record<number, PropertyShape>> = {
  0x1f: 'string',
  0x26: 'pair',
};

type PropertyKind = 'CONNACK' | 'PUBLISH' | 'DISCONNECT' | AcknowledgmentKind;
const disconnectProperties: Readonly<Record<number, PropertyShape>> = {
  0x1c: 'string',
  0x1f: 'string',
  0x26: 'pair',
};
const propertyShapes: Readonly<Record<PropertyKind, Readonly<Record<number, PropertyShape>>>> = {
  CONNACK: connackProperties,
  PUBLISH: publishProperties,
  PUBACK: acknowledgmentProperties,
  PUBREC: acknowledgmentProperties,
  PUBREL: acknowledgmentProperties,
  PUBCOMP: acknowledgmentProperties,
  SUBACK: acknowledgmentProperties,
  UNSUBACK: acknowledgmentProperties,
  DISCONNECT: disconnectProperties,
};

export class NodePacketDecoder {
  private decoder: ReturnType<typeof parser> | undefined;
  private readonly maxPacketBytes: number;
  private header: number | undefined;
  private lengthBytes: number[] = [];
  private remainder: Buffer<ArrayBuffer> | undefined;
  private offset = 0;
  private failure: Error | undefined;
  private ended = false;
  private pushing = false;

  constructor(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The retained parser delivers mutable packets and Buffer payloads.
    options: Readonly<{ maxPacketBytes?: number; onPacket: (packet: Packet) => void }>,
  ) {
    const { maxPacketBytes: capacity = 1024 * 1024 } = options;
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 268_435_460) {
      throw new RangeError('MQTT packet capacity must be an integer from 2 to 268435460');
    }
    this.maxPacketBytes = capacity;
    const decoder = parser({ protocolVersion: 5 });
    this.decoder = decoder;
    decoder.on('packet', options.onPacket);
    decoder.on('error', (reason: unknown) => {
      if (!(reason instanceof Error)) throw new Error('MQTT parser failed');
      // mqtt-packet 9.0.2 exposes these packet-specific failures as message strings.
      if (reason.message === 'Invalid suback code' || reason.message === 'Invalid unsuback code')
        throw new ProtocolInputError(reason.message, 0x82);
      throw reason;
    });
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native views keep mutable backing storage; admitted data is copied before decoding.
  push(bytes: Readonly<Uint8Array>): void {
    this.assertOpen();
    if (this.ended) throw new Error('MQTT decoder has ended');
    if (this.pushing) throw this.reject(new Error('MQTT decoder input is reentrant'));
    this.pushing = true;
    try {
      let index = 0;
      while (index < bytes.length) {
        if (this.remainder) {
          const count = Math.min(this.remainder.length - this.offset, bytes.length - index);
          this.remainder.set(bytes.subarray(index, index + count), this.offset);
          this.offset += count;
          index += count;
          this.flush();
          continue;
        }
        const digit = bytes[index++]!;
        if (this.header === undefined) {
          this.header = digit;
          this.parse(Buffer.of(digit));
          continue;
        }
        this.lengthBytes.push(digit);
        if (digit & 128) {
          if (this.lengthBytes.length === 4) {
            this.parse(Buffer.from(this.lengthBytes));
            throw new Error('Malformed MQTT Remaining Length');
          }
          continue;
        }
        if (digit === 0 && this.lengthBytes.length > 1) throw new Error('Non-canonical MQTT Remaining Length');
        let remainingLength = 0;
        let multiplier = 1;
        for (const byte of this.lengthBytes) {
          remainingLength += (byte & 127) * multiplier;
          multiplier *= 128;
        }
        const size = 1 + this.lengthBytes.length + remainingLength;
        if (size > this.maxPacketBytes) throw new RangeError('MQTT packet allocation limit exceeded');
        this.remainder = Buffer.allocUnsafeSlow(size - 1);
        this.remainder.set(this.lengthBytes);
        this.offset = this.lengthBytes.length;
        this.flush();
      }
    } catch (reason) {
      throw this.reject(reason);
    } finally {
      this.pushing = false;
    }
  }

  finish(): void {
    this.assertOpen();
    if (this.pushing) throw this.reject(new Error('MQTT decoder completion is reentrant'));
    if (this.header !== undefined) throw this.reject(new Error('Truncated MQTT packet at end of input'));
    this.ended = true;
    this.decoder = undefined;
  }

  stop(reason: Readonly<Error>): void {
    this.reject(reason);
  }

  private flush(): void {
    if (this.header === undefined || !this.remainder || this.offset !== this.remainder.length) return;
    const completed = this.remainder;
    if (this.header >>> 4 === 2) this.validateProperties('CONNACK', this.lengthBytes.length + 2);
    if (this.header >>> 4 === 3) {
      const topicStart = this.lengthBytes.length + 2;
      if (topicStart > completed.length) throw new Error('Truncated MQTT PUBLISH topic');
      const topicEnd = topicStart + completed.readUInt16BE(topicStart - 2);
      if (topicEnd > completed.length) throw new Error('Truncated MQTT PUBLISH topic');
      const topic = completed.subarray(topicStart, topicEnd);
      if (!isUtf8(topic) || topic.includes(0)) throw new Error('Invalid MQTT PUBLISH topic UTF-8');
      this.validateProperties('PUBLISH', topicEnd + ((this.header & 6) === 0 ? 0 : 2));
    }
    if (this.header >>> 4 === 14 && completed.length > this.lengthBytes.length + 1)
      this.validateProperties('DISCONNECT', this.lengthBytes.length + 1);
    const acknowledgment = acknowledgmentKinds[this.header >>> 4];
    if (acknowledgment !== undefined) {
      const subscription = acknowledgment === 'SUBACK' || acknowledgment === 'UNSUBACK';
      const propertyStart = this.lengthBytes.length + (subscription ? 2 : 3);
      if (subscription || completed.length > propertyStart) this.validateProperties(acknowledgment, propertyStart);
    }
    this.remainder = undefined;
    this.offset = 0;
    this.header = undefined;
    this.lengthBytes = [];
    this.parse(completed);
  }

  private validateProperties(kind: PropertyKind, offset: number): void {
    const frame = this.remainder!;
    let end = frame.length;
    const shapes = propertyShapes[kind];
    const hasPayload = kind === 'PUBLISH' || kind === 'SUBACK' || kind === 'UNSUBACK';
    const take = (size: number): number => {
      if (offset + size > end) throw new Error('Truncated MQTT ' + kind + ' property');
      const start = offset;
      offset += size;
      return start;
    };
    const variable = (): number => {
      let value = 0;
      for (let index = 0; index < 4; index++) {
        const digit = frame[take(1)]!;
        value += (digit & 127) * 128 ** index;
        if ((digit & 128) === 0) {
          if (index > 0 && value < 128 ** index) throw new Error('Non-canonical MQTT ' + kind + ' property integer');
          return value;
        }
      }
      throw new Error('Malformed MQTT ' + kind + ' property integer');
    };
    const binary = () => {
      const start = take(2);
      const size = frame.readUInt16BE(start);
      return frame.subarray(take(size), offset);
    };
    const string = (identifier: number) => {
      const bytes = binary();
      if (!isUtf8(bytes) || bytes.includes(0)) throw new Error('Invalid MQTT ' + kind + ' property UTF-8');
      if (identifier === 0x08 && (bytes.length === 0 || bytes.includes(0x2b) || bytes.includes(0x23)))
        throw new ProtocolInputError('Invalid MQTT Response Topic', 0x82);
    };
    const seen = new Set<number>();
    const length = variable();
    const propertyEnd = offset + length;
    if (propertyEnd > frame.length || (!hasPayload && propertyEnd !== frame.length))
      throw new Error('Invalid MQTT ' + kind + ' property length');
    end = propertyEnd;
    while (offset < end) {
      const identifier = variable();
      const shape = shapes[identifier];
      if (shape === undefined) throw new Error('Invalid MQTT ' + kind + ' property identifier');
      const repeatable = identifier === 0x26 || (kind === 'PUBLISH' && identifier === 0x0b);
      if (!repeatable) {
        if (seen.has(identifier)) {
          if (identifier === 0x23) throw new ProtocolInputError('Duplicate MQTT Topic Alias property', 0x82);
          throw new Error('Duplicate MQTT ' + kind + ' property');
        }
        seen.add(identifier);
      }
      switch (shape) {
        case 'string':
          string(identifier);
          break;
        case 'pair':
          string(identifier);
          string(identifier);
          break;
        case 'binary':
          binary();
          break;
        case 'four':
          this.validateScalar(identifier, frame.readUInt32BE(take(4)));
          break;
        case 'two':
          this.validateScalar(identifier, frame.readUInt16BE(take(2)));
          break;
        case 'byte':
          this.validateScalar(identifier, frame[take(1)]!);
          break;
        case 'variable':
          this.validateScalar(identifier, variable());
          break;
      }
    }
  }

  private validateScalar(identifier: number, value: number): void {
    switch (identifier) {
      case 0x01:
      case 0x24:
      case 0x25:
      case 0x28:
      case 0x29:
      case 0x2a:
        if (value !== 0 && value !== 1) throw new Error('Invalid MQTT property value');
        break;
      case 0x21:
      case 0x27:
      case 0x0b:
        if (value < 1) throw new Error('Invalid zero MQTT property value');
        break;
      case 0x23:
        if (value < 1) throw new ProtocolInputError('Invalid MQTT Topic Alias', 0x94);
        break;
    }
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The retained parser consumes native Buffer objects.
  private parse(bytes: Buffer): void {
    if (!this.decoder) throw this.failure ?? new Error('MQTT decoder has ended');
    this.decoder.parse(bytes);
    this.assertOpen();
  }

  private assertOpen(): void {
    if (this.failure) throw this.failure;
  }

  private reject(reason: unknown): Error {
    this.failure ??= reason instanceof Error ? reason : new Error('MQTT decode failed');
    this.decoder = undefined;
    this.remainder = undefined;
    this.lengthBytes = [];
    this.offset = 0;
    this.header = undefined;
    return this.failure;
  }
}
