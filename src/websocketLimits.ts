import { DEFAULT_MAX_PACKET_BYTES } from './packetFramer.js';

export function resolveWebSocketMessageLimit(maxPacketBytes = DEFAULT_MAX_PACKET_BYTES, limit = 2 * maxPacketBytes): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 2_147_483_647) {
    throw new RangeError('WebSocket receive message limit must be an integer from 1 to 2147483647');
  }
  return limit;
}
