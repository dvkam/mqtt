import { generate } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { SubscriptionExchanges, resolveSubscriptionLimits } from '../src/subscriptionExchanges.js';

test.each([0, -1, 1.5, NaN, Infinity, 65_536])('rejects invalid entry capacity %s', (maxPendingSubscriptions) => {
  expect(() => resolveSubscriptionLimits({ maxPendingSubscriptions })).toThrow(RangeError);
});

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid byte capacity %s',
  (maxPendingSubscriptionBytes) => {
    expect(() => resolveSubscriptionLimits({ maxPendingSubscriptionBytes })).toThrow(RangeError);
  },
);

test.each(['a', 'é', '😀', 'a'.repeat(121), 'a'.repeat(122), 'a'.repeat(16_377), 'a'.repeat(16_378), 'é'.repeat(32_767)])(
  'charges exact single-filter wire bytes including Remaining Length transitions',
  (topic) => {
    const bytes = generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos: 0 }] }, { protocolVersion: 5 }).length;
    const rejected = new SubscriptionExchanges({ maxPendingSubscriptionBytes: bytes - 1 });
    expect(() => rejected.reserve(topic)).toThrow('MQTT subscription capacity exceeded');
    const registry = new SubscriptionExchanges({ maxPendingSubscriptionBytes: bytes });
    const first = registry.reserve(topic);
    expect(first.messageId).toBe(1);
    expect(() => registry.reserve(topic)).toThrow('MQTT subscription capacity exceeded');
    registry.accept(first.messageId, [0]);
    first.release();
  },
);

test('wraps the full identifier range, rejects exhaustion and protects a reused ID from old release', async () => {
  const registry = new SubscriptionExchanges({ maxPendingSubscriptions: 65_535 });
  const reservations = Array.from({ length: 65_535 }, () => registry.reserve('a'));
  expect(new Set(reservations.map((entry: Readonly<{ messageId: number }>) => entry.messageId)).size).toBe(65_535);
  expect(reservations[0]!.messageId).toBe(1);
  expect(reservations[65_534]!.messageId).toBe(65_535);
  expect(() => registry.reserve('a')).toThrow('MQTT subscription capacity exceeded');
  const old = reservations[1]!;
  registry.accept(2, [0]);
  await old.acknowledged;
  old.release();
  const reused = registry.reserve('a');
  expect(reused.messageId).toBe(2);
  old.release();
  expect(() => registry.reserve('a')).toThrow('MQTT subscription capacity exceeded');
  for (const entry of reservations) registry.accept(entry.messageId, [0]);
  registry.accept(2, [0]);
  const acknowledgments = [reused.acknowledged];
  for (const entry of reservations) acknowledgments.push(entry.acknowledged);
  await Promise.all(acknowledgments);
  for (const entry of reservations) entry.release();
  reused.release();
});

test('snapshots the first matching result and ignores unknown and duplicate acknowledgments', async () => {
  const registry = new SubscriptionExchanges({});
  const reservation = registry.reserve('a');
  const granted = [128];
  registry.accept(undefined, [0]);
  registry.accept(99, [0]);
  registry.accept(reservation.messageId, granted);
  granted[0] = 0;
  registry.accept(reservation.messageId, [0]);
  expect(await reservation.acknowledged).toBe(128);
  reservation.release();
});

test('retirement rejects pending ownership with its first cause and fences reservation', async () => {
  const registry = new SubscriptionExchanges({});
  const first = registry.reserve('a');
  const second = registry.reserve('b');
  const outcomes = Promise.allSettled([first.acknowledged, second.acknowledged]);
  const failure = new Error('retired');
  registry.retire(failure);
  registry.retire(new Error('later'));
  registry.accept(first.messageId, [0]);
  first.release();
  second.release();
  expect(await outcomes).toEqual([
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure },
  ]);
  expect(() => registry.reserve('a')).toThrow(failure);
});
