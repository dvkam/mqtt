import { parser, type Packet } from 'mqtt-packet';

export class BoundedNodeDecoder {
  private decoder: ReturnType<typeof parser> | undefined;
  private readonly maxPacketBytes: number;
  private readonly assembly: 'compact' | 'streaming';
  private firstByte = true;
  private lengthBytes: number[] = [];
  private remainder: Buffer<ArrayBuffer> | undefined;
  private offset = 0;
  private streamingRemaining = 0;
  private failure: Error | undefined;
  private ended = false;
  private pushing = false;

  constructor(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The retained parser delivers mutable packets and Buffer payloads.
    options: Readonly<{ maxPacketBytes?: number; assembly?: 'compact' | 'streaming'; onPacket: (packet: Packet) => void }>,
  ) {
    const capacity = options.maxPacketBytes ?? 1024 * 1024;
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 268_435_460) {
      throw new RangeError('MQTT packet capacity must be an integer from 2 to 268435460');
    }
    this.maxPacketBytes = capacity;
    this.assembly = options.assembly ?? 'compact';
    const decoder = parser({ protocolVersion: 5 });
    this.decoder = decoder;
    decoder.on('packet', options.onPacket);
    decoder.on('error', (reason: unknown) => {
      throw reason instanceof Error ? reason : new Error('MQTT parser failed');
    });
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native views keep mutable backing storage; compact mode copies admitted data.
  push(bytes: Readonly<Uint8Array>): void {
    this.assertOpen();
    if (this.ended) throw new Error('MQTT decoder has ended');
    if (this.pushing) throw this.reject(new Error('MQTT decoder input is reentrant'));
    this.pushing = true;
    try {
      let index = 0;
      while (index < bytes.length) {
        if (this.streamingRemaining > 0) {
          const count = Math.min(this.streamingRemaining, bytes.length - index);
          this.streamingRemaining -= count;
          if (this.streamingRemaining === 0) this.firstByte = true;
          const fragment = Buffer.from(bytes.buffer, bytes.byteOffset + index, count);
          index += count;
          this.parse(fragment);
          continue;
        }
        if (this.remainder) {
          const count = Math.min(this.remainder.length - this.offset, bytes.length - index);
          this.remainder.set(bytes.subarray(index, index + count), this.offset);
          this.offset += count;
          index += count;
          this.flush();
          continue;
        }
        const digit = bytes[index++]!;
        if (this.firstByte) {
          this.firstByte = false;
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
        let remainingLength = 0;
        let multiplier = 1;
        for (const byte of this.lengthBytes) {
          remainingLength += (byte & 127) * multiplier;
          multiplier *= 128;
        }
        const size = 1 + this.lengthBytes.length + remainingLength;
        if (size > this.maxPacketBytes) throw new RangeError('MQTT packet allocation limit exceeded');
        if (this.assembly === 'streaming') {
          const length = Buffer.from(this.lengthBytes);
          this.lengthBytes = [];
          this.streamingRemaining = remainingLength;
          if (remainingLength === 0) this.firstByte = true;
          this.parse(length);
          continue;
        }
        this.remainder = Buffer.allocUnsafeSlow(size - 1);
        this.remainder.set(this.lengthBytes);
        this.offset = this.lengthBytes.length;
        this.lengthBytes = [];
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
    if (!this.firstByte) throw this.reject(new Error('Truncated MQTT packet at end of input'));
    this.ended = true;
    this.decoder = undefined;
  }

  stop(reason: Readonly<Error>): void {
    this.reject(reason);
  }

  private flush(): void {
    if (!this.remainder || this.offset !== this.remainder.length) return;
    const completed = this.remainder;
    this.remainder = undefined;
    this.offset = 0;
    this.firstByte = true;
    this.parse(completed);
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
    this.streamingRemaining = 0;
    this.firstByte = true;
    return this.failure;
  }
}
