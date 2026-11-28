import type { FramerOptions, PacketFramer } from './packetFramer.js';
import type { ReadonlyBytes } from './util/bytes.js';

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
  readonly bytes: (value: ReadonlyBytes) => Bytes;
}
