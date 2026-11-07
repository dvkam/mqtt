import { expect, test } from 'vitest';
import { compareDelivery } from './experiments/delivery-comparison.js';

test.each(['callback', 'iterator', 'web-stream'] as const)('%s accounts for every ordered message', async (mode) => {
  const result = await compareDelivery(mode, 2000);
  expect(result).toMatchObject({ attempted: 2000, received: 2000, ordered: true, checksum: 1_999_000 });
  expect(result.peakMessages).toBeLessThanOrEqual(16);
  expect(result.peakBytes).toBeLessThanOrEqual(16 * 258);
  expect(result.messagesPerSecond).toBeGreaterThan(0);
});
