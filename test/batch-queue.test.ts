import { expect, test } from 'vitest';
import type { BrowserMessage } from '../src/browserClient.js';
import { createMessageQueue } from './experiments/message-queue.js';

function publication(sequence: number, bytes = 1): BrowserMessage {
  const payload = new Uint8Array(bytes);
  payload[0] = sequence;
  return { cmd: 'publish', topic: 'a', payload, qos: 0, dup: false, retain: false };
}

function ids(messages: readonly Readonly<{ payload: Readonly<{ readonly [index: number]: number }> }>[]) {
  return messages.map(({ payload }) => payload[0]);
}

test('batches the staged head and ready FIFO entries up to its item limit', async () => {
  const queue = createMessageQueue({ maxMessages: 8, maxBytes: 24 });
  const batches = queue.iterateBatches(3);
  const pending = batches.next();
  for (let sequence = 1; sequence <= 4; sequence++) queue.push(publication(sequence));
  const first = await pending;
  if (first.done === true) throw new Error('Expected a batch');
  expect(ids(first.value)).toEqual([1, 2, 3]);
  expect(queue.snapshot()).toMatchObject({ messages: 1, bytes: 3 });
  queue.close();
  const last = await batches.next();
  if (last.done === true) throw new Error('Expected a final batch');
  expect(ids(last.value)).toEqual([4]);
  await expect(batches.next()).resolves.toEqual({ done: true, value: undefined });
});

test('includes the staged item in the byte limit and leaves the next FIFO item queued', async () => {
  const queue = createMessageQueue({ maxMessages: 3, maxBytes: 8 });
  const batches = queue.iterateBatches(3);
  const pending = batches.next();
  queue.push(publication(1, 3));
  queue.push(publication(2, 2));
  queue.push(publication(3, 2));
  const first = await pending;
  if (first.done === true) throw new Error('Expected the staged item');
  expect(ids(first.value)).toEqual([1]);
  expect(queue.snapshot()).toMatchObject({ messages: 2, bytes: 8 });
  const second = await batches.next();
  if (second.done === true) throw new Error('Expected the queued items');
  expect(ids(second.value)).toEqual([2, 3]);
  const buffer = second.value[0]?.payload.buffer;
  if (!(buffer instanceof ArrayBuffer)) throw new Error('Expected a transferable payload');
  structuredClone(buffer, { transfer: [buffer] });
  expect(ids(second.value.slice(1))).toEqual([3]);
  expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0 });
});

test('shares the exclusive consumer claim and rejects overlapping batch assembly', async () => {
  const queue = createMessageQueue({ maxMessages: 3, maxBytes: 9 });
  expect(() => queue.iterateBatches(0)).toThrow(RangeError);
  queue.push(publication(1));
  queue.push(publication(2));
  queue.push(publication(3));
  const batches = queue.iterateBatches(2);
  expect(() => queue.iterate()).toThrow('already owns');
  expect(() => queue.stream()).toThrow('already owns');
  const first = batches.next();
  await expect(batches.next()).rejects.toThrow('already pending');
  const result = await first;
  if (result.done === true) throw new Error('Expected the first batch');
  expect(ids(result.value)).toEqual([1, 2]);
  const last = await batches.next();
  if (last.done === true) throw new Error('Expected the remaining item');
  expect(ids(last.value)).toEqual([3]);
});

function stagedBatch() {
  const queue = createMessageQueue({ maxMessages: 3, maxBytes: 9 });
  const batches = queue.iterateBatches(2);
  const pending = batches.next().catch((reason: unknown) => reason);
  queue.push(publication(1));
  queue.push(publication(2));
  return { queue, batches, pending };
}

test('graceful close preserves the staged item and drains ready work', async () => {
  const { queue, pending } = stagedBatch();
  queue.close();
  await expect(pending).resolves.toEqual({ done: false, value: [publication(1), publication(2)] });
  expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0 });
});

test('return discards a staged item before it is delivered', async () => {
  const { queue, batches, pending } = stagedBatch();
  await expect(batches.return?.()).resolves.toEqual({ done: true, value: undefined });
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0 });
});

test('iterator throw preserves its reason and discards a staged item', async () => {
  const { queue, batches, pending } = stagedBatch();
  const failure = new Error('consumer stopped');
  await expect(batches.throw?.(failure)).rejects.toBe(failure);
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0 });
});

test('source failure before commit rejects with the original error', async () => {
  const { queue, batches, pending } = stagedBatch();
  const failure = new Error('source retired');
  queue.fail(failure);
  await expect(pending).resolves.toBe(failure);
  await expect(batches.next()).rejects.toBe(failure);
  expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0 });
});

test('flushes a partial batch as soon as the first item arrives', async () => {
  const queue = createMessageQueue({ maxMessages: 16, maxBytes: 48 });
  const batches = queue.iterateBatches(16);
  const pending = batches.next();
  queue.push(publication(1));
  await expect(pending).resolves.toEqual({ done: false, value: [publication(1)] });
  await batches.return?.();
});
