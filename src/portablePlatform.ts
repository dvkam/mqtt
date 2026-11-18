import type { BytePlatform } from './bytePlatform.js';
import { PacketFramer } from './packetFramer.js';

/** Frames into plain Uint8Arrays and delivers them as they are. Uses no Node API, so a browser bundle can include it. */
export const portablePlatform: BytePlatform<Uint8Array> = {
  framer: (options) => new PacketFramer(options),
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Payloads are the framer's own mutable byte views.
  bytes: (value) => value,
};
