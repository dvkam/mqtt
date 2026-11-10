import { expect, test } from 'vitest';
import { assertFixedRateDelivery, runFixedRateDelivery } from './experiments/fixed-rate-delivery.ts';

const plan = { burstCount: 3, burstSize: 4, periodMs: 10, queueLimit: 16 };

function clock() {
  const deadlines: number[] = [];
  let time = 100;
  return {
    deadlines,
    now: () => time,
    async waitUntil(deadline: number) {
      await Promise.resolve();
      deadlines.push(deadline);
      time = deadline + 3;
    },
  };
}

test.each(['callback', 'iterator', 'web-stream'] as const)('%s delivers the same absolute burst schedule', async (mode) => {
  const scheduler = clock();
  const result = await runFixedRateDelivery(mode, plan, scheduler);
  expect(scheduler.deadlines).toEqual([110, 120, 130]);
  expect(result).toMatchObject({
    offered: 12,
    received: 12,
    ordered: true,
    checksum: 66,
    p99ScheduleDelayMs: 3,
    pending: 0,
    failure: null,
  });
  expect(() => {
    assertFixedRateDelivery(result, plan);
  }).not.toThrow();
});

test.each(['iterator', 'web-stream'] as const)('%s keeps offering the fixed schedule after queue overflow', async (mode) => {
  const scheduler = clock();
  const overloaded = { ...plan, queueLimit: 2 };
  const result = await runFixedRateDelivery(mode, overloaded, scheduler);
  expect(scheduler.deadlines).toEqual([110, 120, 130]);
  expect(result).toMatchObject({ offered: 12, pending: 0, failure: 'Application message queue capacity exceeded' });
  expect(result.received).toBeLessThan(result.offered);
  expect(() => {
    assertFixedRateDelivery(result, overloaded);
  }).toThrow('delivery gate');
});

test('the allocation gate rejects silent drops, changed sequences, and reordering', async () => {
  const result = await runFixedRateDelivery('callback', plan, clock());
  expect(() => {
    assertFixedRateDelivery({ ...result, received: 11 }, plan);
  }).toThrow('delivery gate');
  expect(() => {
    assertFixedRateDelivery({ ...result, checksum: 65 }, plan);
  }).toThrow('delivery gate');
  expect(() => {
    assertFixedRateDelivery({ ...result, ordered: false }, plan);
  }).toThrow('delivery gate');
});

test('a batched profile validates delivery and its reduced dispatch count', async () => {
  const result = await runFixedRateDelivery('batch-4', plan, clock());
  expect(result).toMatchObject({ offered: 12, received: 12, ordered: true, checksum: 66, pending: 0, failure: null });
  expect(result.dispatches).toBeLessThan(result.received);
  expect(result.peakBatchMessages).toBe(4);
  assertFixedRateDelivery(result, plan);
  expect(() => {
    assertFixedRateDelivery({ ...result, dispatches: 1 }, plan);
  }).toThrow('delivery gate');
});
