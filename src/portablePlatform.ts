import type { BytePlatform } from './bytePlatform.js';
import { PacketFramer } from './packetFramer.js';

/** Frames into plain Uint8Arrays and delivers them as they are. Uses no Node API, so a browser bundle can include it. */
export const portablePlatform: BytePlatform<Uint8Array> = {
  framer: (options) => new PacketFramer(options),
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The converter returns `value` itself as the delivered payload, and the application receives it as its own writable payload (the handlers in test/types/public-client-types.ts fill it). A read-only parameter type would be false for bytes that are handed on as writable.
  bytes: (value) => value,
};
