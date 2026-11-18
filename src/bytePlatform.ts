import type { PacketFramer } from './packetFramer.js';
import type { FramedPacket } from './wireCodec.js';

export type FramerFactoryOptions = Readonly<{
  maxPacketBytes?: number;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The framer delivers mutable packets and byte views of its allocation.
  onPacket: (packet: FramedPacket) => void;
}>;

/**
 * What differs between platforms on the inbound path: how the framer allocates each packet and which byte type the
 * session delivers. The core imports no platform, so it bundles for Node and for a browser.
 */
export interface BytePlatform<Bytes extends Uint8Array> {
  /** Create the framer for one connection. */
  readonly framer: (options: FramerFactoryOptions) => PacketFramer;
  /** View a decoded payload or byte property as `Bytes` without copying. */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Decoded byte views keep their mutable backing allocation.
  readonly bytes: (value: Uint8Array) => Bytes;
}
