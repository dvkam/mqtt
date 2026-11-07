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
