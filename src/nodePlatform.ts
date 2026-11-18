import type { BytePlatform } from './bytePlatform.js';
import { nodeBytes } from './nodeMessage.js';
import { NodePacketDecoder } from './nodePacketDecoder.js';

/** Node frames each packet into one unpooled Buffer and delivers Buffer views of it. */
export const nodePlatform: BytePlatform<Buffer> = {
  framer: (options) => new NodePacketDecoder(options),
  bytes: nodeBytes,
};
