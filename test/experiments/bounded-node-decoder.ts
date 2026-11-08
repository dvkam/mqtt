import { parser, type Packet } from 'mqtt-packet';

export class BoundedNodeDecoder {
  private readonly decoder = parser({ protocolVersion: 5 });

  constructor(options: Readonly<{ maxPacketBytes?: number; assembly?: 'compact' | 'streaming'; onPacket: (packet: Packet) => void }>) {
    this.decoder.on('packet', options.onPacket);
    this.decoder.on('error', (reason: unknown) => {
      throw reason instanceof Error ? reason : new Error('MQTT parser failed');
    });
  }

  push(bytes: Readonly<Uint8Array>): void {
    this.decoder.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  finish(): void {}

  stop(_reason: Readonly<Error>): void {}
}
