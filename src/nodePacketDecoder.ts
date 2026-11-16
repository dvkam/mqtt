import { PacketFramer, type FramerOptions } from './packetFramer.ts';

function nodeAllocation(size: number): Buffer<ArrayBuffer> {
  return Buffer.allocUnsafeSlow(size);
}

/** The framer on Node: each packet lives in one unpooled Buffer, so payloads and byte properties are Buffer views of it. */
export class NodePacketDecoder extends PacketFramer {
  constructor(options: Omit<FramerOptions, 'allocate'>) {
    super({ ...options, allocate: nodeAllocation });
  }
}
