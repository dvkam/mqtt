export function resolveWebSocketMessageLimit(value = 1024 * 1024): number {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError('WebSocket receive message limit must be an integer from 1 to 2147483647');
  }
  return value;
}
