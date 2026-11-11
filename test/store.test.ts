import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import type { Packet } from 'mqtt-packet';

test('stores and removes the original packet object', async () => {
  const store = new Store();
  const packet: Packet = { cmd: 'puback', messageId: 7 };
  expect(await store.put(packet)).toBe(store);
  expect(await store.get(packet)).toBe(packet);
  expect(await store.del(packet)).toBe(packet);
  await expect(store.get(packet)).rejects.toThrow('missing packet');
  await expect(store.del(packet)).rejects.toThrow('missing packet');
});

test('clean close rejects later operations through their promises', async () => {
  const store = new Store({ clean: true });
  const packet: Packet = { cmd: 'puback', messageId: 7 };
  await store.put(packet);
  await store.close();
  await expect(store.put(packet)).rejects.toBeInstanceOf(TypeError);
  await expect(store.get(packet)).rejects.toBeInstanceOf(TypeError);
  await expect(store.del(packet)).rejects.toBeInstanceOf(TypeError);
  await expect(store.createStream()).rejects.toBeInstanceOf(TypeError);
});

test('a stream snapshots the stored packet identities', async () => {
  const store = new Store();
  const first: Packet = { cmd: 'puback', messageId: 1 };
  const second: Packet = { cmd: 'puback', messageId: 2 };
  await store.put(first);
  const stream = await store.createStream();
  await store.put(second);
  const received: unknown[] = [];
  for await (const packet of stream) received.push(packet);
  expect(received).toHaveLength(1);
  expect(received[0]).toBe(first);
});

test.each([
  { label: 'omitted options', input: undefined },
  { label: 'empty options', input: {} },
] as const)('default clean close retires the store with $label', async ({ input }) => {
  const store = new Store(input);
  const packet: Packet = { cmd: 'puback', messageId: 8 };
  await store.put(packet);
  await store.close();
  await store.close();
  expect(store.options.clean).toBe(true);
  await expect(store.put(packet)).rejects.toThrow('Store is closed');
  await expect(store.get(packet)).rejects.toThrow('Store is closed');
  await expect(store.del(packet)).rejects.toThrow('Store is closed');
  await expect(store.createStream()).rejects.toThrow('Store is closed');
});

test('explicit clean false preserves stored packet identity after close', async () => {
  const store = new Store({ clean: false });
  const packet: Packet = { cmd: 'puback', messageId: 9 };
  await store.put(packet);
  await store.close();
  expect(store.options.clean).toBe(false);
  expect(await store.get(packet)).toBe(packet);
  expect(await store.del(packet)).toBe(packet);
  expect(await store.put(packet)).toBe(store);
});

test('an existing snapshot keeps the original packets after clean store close', async () => {
  const store = new Store();
  const packet: Packet = { cmd: 'puback', messageId: 10 };
  await store.put(packet);
  const snapshot = await store.createStream();
  await store.close();
  const received: unknown[] = [];
  for await (const entry of snapshot) received.push(entry);
  expect(received).toHaveLength(1);
  expect(received[0]).toBe(packet);
  await expect(store.get(packet)).rejects.toThrow('Store is closed');
});
