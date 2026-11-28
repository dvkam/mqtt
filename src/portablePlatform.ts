import type { BytePlatform } from './bytePlatform.js';
import { PacketFramer } from './packetFramer.js';
import type { ReadonlyBytes } from './util/bytes.js';

/** Frames into plain Uint8Arrays and delivers them as they are. Uses no Node API, so a browser bundle can include it. */
export const portablePlatform: BytePlatform<Uint8Array> = {
  framer: (options) => new PacketFramer(options),
  bytes: (value: ReadonlyBytes) => value,
};
