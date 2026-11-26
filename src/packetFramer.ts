import { decodeFramedPacket, isClientOnlyCommand, type FramedPacket } from './wireCodec.ts';
import { ReceiveLimitError } from './mqttError.ts';
import { brokerPacketDirectionError, ProtocolInputError } from './protocolInputError.ts';

export const DEFAULT_MAX_PACKET_BYTES = 1024 * 1024;

const packetNames = [
  'reserved',
  'connect',
  'connack',
  'publish',
  'puback',
  'pubrec',
  'pubrel',
  'pubcomp',
  'subscribe',
  'suback',
  'unsubscribe',
  'unsuback',
  'pingreq',
  'pingresp',
  'disconnect',
  'auth',
] as const;

/** MQTT 5 section 2.1.3. Reject reserved flag bits as soon as the first byte arrives. */
function validateFixedHeader(header: number): void {
  const type = header >>> 4;
  const flags = header & 15;
  if (type !== 0 && type !== 3) {
    const required = type === 6 || type === 8 || type === 10 ? 2 : 0;
    if (flags !== required)
      throw new Error('Invalid header flag bits, must be 0x' + required + ' for ' + packetNames[type] + ' packet');
  }
  if (((header >>> 1) & 3) === 3) throw new Error('Packet must not have both QoS bits set to 1');
  // MQTT-3.3.1-2: a QoS 0 PUBLISH has DUP 0. Before the portable parse, mqtt-packet delivered it.
  if (type === 3 && (header & 0x0e) === 0x08) throw new ProtocolInputError('Invalid MQTT PUBLISH DUP flag for QoS 0', 0x81);
  const name = packetNames[type] ?? 'reserved';
  if (isClientOnlyCommand(name)) throw brokerPacketDirectionError(name);
}

/**
 * Allocate one packet region of exactly `size` bytes. The framer fills it and decodes it, and the payload and byte
 * properties it delivers are views of it. Return fresh memory that the allocator never hands out again: a pooled or
 * shared region would let a later packet overwrite a payload already delivered. If the allocator stops the framer, the
 * framer discards the region and fails with the stop reason.
 */
export type PacketAllocator = (size: number) => Uint8Array<ArrayBuffer>;

export type FramerOptions = Readonly<{
  maxPacketBytes?: number;
  /** Defaults to `new Uint8Array(size)`. The Node decoder passes an unpooled Node allocation. */
  allocate?: PacketAllocator;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The framer delivers mutable packets and byte views of its allocation.
  onPacket: (packet: FramedPacket) => void;
}>;

function plainAllocation(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(size);
}

/**
 * Frames broker packets from byte chunks of any size, checks each fixed header on its first byte, bounds each packet by
 * `maxPacketBytes` before allocating it, copies it into one allocation and decodes it with the codec. It uses no Node API.
 */
export class PacketFramer {
  private open = true;
  private readonly onPacket: FramerOptions['onPacket'];
  private readonly allocate: PacketAllocator;
  readonly maxPacketBytes: number;
  private header: number | undefined;
  private lengthBytes: number[] = [];
  private remainder: Uint8Array<ArrayBuffer> | undefined;
  private offset = 0;
  private failure: Error | undefined;
  private ended = false;
  private pushing = false;

  constructor(options: FramerOptions) {
    const { maxPacketBytes: capacity = DEFAULT_MAX_PACKET_BYTES } = options;
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 268_435_460) {
      throw new RangeError('MQTT packet capacity must be an integer from 2 to 268435460');
    }
    this.maxPacketBytes = capacity;
    this.onPacket = options.onPacket;
    this.allocate = options.allocate ?? plainAllocation;
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
          validateFixedHeader(digit);
          continue;
        }
        this.lengthBytes.push(digit);
        if (digit & 128) {
          if (this.lengthBytes.length === 4) {
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
        if (size > this.maxPacketBytes) throw new ReceiveLimitError('MQTT packet allocation limit exceeded');
        const region = this.allocate(size - 1);
        // The allocator is caller code and can stop the framer.
        this.assertOpen();
        if (region.length !== size - 1) throw new RangeError('MQTT packet allocator returned the wrong size');
        this.remainder = region;
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
    this.open = false;
  }

  stop(reason: Readonly<Error>): void {
    this.reject(reason);
  }

  private flush(): void {
    if (this.header === undefined || !this.remainder || this.offset !== this.remainder.length) return;
    const completed = this.remainder;
    const header = this.header;
    this.remainder = undefined;
    this.offset = 0;
    this.header = undefined;
    this.lengthBytes = [];
    if (!this.open) throw this.failure ?? new Error('MQTT decoder has ended');
    if (header >>> 4 === 0) throw new Error('Not supported');
    this.onPacket(decodeFramedPacket(header, completed));
    this.assertOpen();
  }

  private assertOpen(): void {
    if (this.failure) throw this.failure;
  }

  private reject(reason: unknown): Error {
    this.failure ??= reason instanceof Error ? reason : new Error('MQTT decode failed');
    this.open = false;
    this.remainder = undefined;
    this.lengthBytes = [];
    this.offset = 0;
    this.header = undefined;
    return this.failure;
  }
}
