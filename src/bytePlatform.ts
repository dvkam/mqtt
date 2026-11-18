import type { FramerOptions, PacketFramer } from './packetFramer.js';

/** The platform supplies the allocator, so the core passes only the limit and the packet sink. */
export type FramerFactoryOptions = Omit<FramerOptions, 'allocate'>;

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
