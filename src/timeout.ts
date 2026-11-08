export function resolveTimeout(timeoutMs = 3000): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('MQTT timeout must be a positive integer and fit in a timer');
  }
  return timeoutMs;
}
