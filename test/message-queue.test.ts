import { expect, test } from 'vitest';
import { createMessageQueue } from './experiments/message-queue.js';
import type { BrowserMessage } from '../src/browserClient.js';

type RequireFalse<Value extends false> = Value;
type IsAny<Value> = 0 extends 1 & Value ? true : false;
type Queue = ReturnType<typeof createMessageQueue>;
type QueueIterator = ReturnType<Queue['iterate']>;
type NextResult = Awaited<ReturnType<QueueIterator['next']>>;
export type IteratorValueIsSpecific = RequireFalse<IsAny<NextResult['value']>>;

function message(value = 1): BrowserMessage {
  return { cmd: 'publish', topic: 'a', payload: Uint8Array.of(value), qos: 0, dup: false, retain: false };
}

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid queue capacity %s',
  (capacity) => {
    expect(() => createMessageQueue({ maxMessages: capacity, maxBytes: 20 })).toThrow(RangeError);
    expect(() => createMessageQueue({ maxMessages: 2, maxBytes: capacity })).toThrow(RangeError);
  },
);

test('preserves order, exact capacity and source completion drain', async () => {
  const queue = createMessageQueue({ maxMessages: 2, maxBytes: 6 });
  queue.push(message(1));
  queue.push(message(2));
  expect(queue.snapshot()).toEqual({ messages: 2, bytes: 6, peakMessages: 2, peakBytes: 6 });
  queue.close();
  queue.close();
  queue.push(message(3));
  const iterator = queue.iterate();
  await expect(iterator.next()).resolves.toMatchObject({ value: { payload: Uint8Array.of(1) }, done: false });
  expect(queue.snapshot().bytes).toBe(3);
  await expect(iterator.next()).resolves.toMatchObject({ value: { payload: Uint8Array.of(2) }, done: false });
  await expect(iterator.next()).resolves.toMatchObject({ done: true });
  expect(queue.snapshot().bytes).toBe(0);
});

test.each(['items', 'bytes'] as const)('overflow by %s errors the facade and releases all queued data', async (limit) => {
  const queue = createMessageQueue({ maxMessages: limit === 'items' ? 1 : 3, maxBytes: limit === 'bytes' ? 5 : 30 });
  queue.push(message(1));
  expect(() => {
    queue.push(message(2));
  }).not.toThrow();
  expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0, peakMessages: 1, peakBytes: 3 });
  const iterator = queue.iterate();
  const first = await iterator.next().catch((error: unknown) => error);
  expect(first).toMatchObject({ message: 'Application message queue capacity exceeded' });
  await expect(iterator.next()).rejects.toBe(first);
  queue.push(message(3));
  expect(queue.snapshot().messages).toBe(0);
});

test('rejects an oversized message even when a consumer is waiting', async () => {
  const queue = createMessageQueue({ maxMessages: 1, maxBytes: 2 });
  const pending = queue
    .iterate()
    .next()
    .catch((error: unknown) => error);
  queue.push(message());
  await expect(pending).resolves.toMatchObject({ message: 'Application message queue capacity exceeded' });
  expect(queue.snapshot().peakBytes).toBe(0);
});

test('owns compact payloads and counts topic and repeated property data', async () => {
  const queue = createMessageQueue({ maxMessages: 2, maxBytes: 11 });
  const backing = new Uint8Array(4096);
  backing[30] = 9;
  const properties: [string, string][] = [
    ['k', 'v'],
    ['k', ''],
  ];
  const original = { ...message(), payload: backing.subarray(30, 31), userProperties: properties };
  queue.push(original);
  original.topic = 'changed';
  backing[30] = 0;
  properties[0] = ['changed', 'changed'];
  const result = await queue.iterate().next();
  expect(result.value).toMatchObject({
    topic: 'a',
    payload: Uint8Array.of(9),
    userProperties: [
      ['k', 'v'],
      ['k', ''],
    ],
  });
  const received: unknown = result.value;
  expect(received).toHaveProperty('payload.buffer.byteLength', 1);
  expect(queue.snapshot().peakBytes).toBe(9);
});

test('counts an empty payload and topic using its item limit', async () => {
  const queue = createMessageQueue({ maxMessages: 1, maxBytes: 1 });
  queue.push({ ...message(), topic: '', payload: new Uint8Array() });
  queue.push({ ...message(), topic: '', payload: new Uint8Array() });
  await expect(queue.iterate().next()).rejects.toThrow('capacity exceeded');
});

test('permits one consumer and one outstanding iterator request', async () => {
  const queue = createMessageQueue({ maxMessages: 1, maxBytes: 3 });
  const iterator = queue.iterate();
  const pending = iterator.next();
  await expect(iterator.next()).rejects.toThrow('A message read is already pending');
  expect(() => queue.iterate()).toThrow('A message consumer already owns this queue');
  expect(() => queue.stream()).toThrow('A message consumer already owns this queue');
  queue.close();
  await expect(pending).resolves.toMatchObject({ done: true });
});

test('iterator return discards data and settles a pending read permanently', async () => {
  const queue = createMessageQueue({ maxMessages: 2, maxBytes: 6 });
  const iterator = queue.iterate();
  const pending = iterator.next();
  await iterator.return?.();
  await expect(pending).resolves.toMatchObject({ done: true });
  queue.push(message());
  await expect(iterator.next()).resolves.toMatchObject({ done: true });
  expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0 });
});

test('an iterator break releases the remaining queue', async () => {
  const queue = createMessageQueue({ maxMessages: 2, maxBytes: 6 });
  queue.push(message(1));
  queue.push(message(2));
  for await (const received of queue.iterate()) {
    expect(received.payload).toEqual(Uint8Array.of(1));
    break;
  }
  expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0 });
});

test('iterator throw rejects with its reason and settles an outstanding read', async () => {
  const queue = createMessageQueue({ maxMessages: 1, maxBytes: 3 });
  const iterator = queue.iterate();
  const pending = iterator.next();
  const reason = new Error('consumer failed');
  await expect(iterator.throw?.(reason)).rejects.toBe(reason);
  await expect(pending).resolves.toMatchObject({ done: true });
  queue.push(message());
  expect(queue.snapshot().bytes).toBe(0);
});

test('source failure discards the queue and preserves its original reason', async () => {
  const queue = createMessageQueue({ maxMessages: 2, maxBytes: 6 });
  const iterator = queue.iterate();
  const pending = iterator.next().catch((error: unknown) => error);
  const reason = new Error('source failed');
  queue.fail(reason);
  queue.fail(new Error('later'));
  queue.close();
  await expect(pending).resolves.toBe(reason);
  await expect(iterator.next()).rejects.toBe(reason);
});

test('the Web Streams facade has no hidden prefetch queue', async () => {
  const queue = createMessageQueue({ maxMessages: 2, maxBytes: 6 });
  const stream = queue.stream();
  queue.push(message(1));
  queue.push(message(2));
  await Promise.resolve();
  expect(queue.snapshot().messages).toBe(2);
  const reader = stream.getReader();
  await expect(reader.read()).resolves.toMatchObject({ value: { payload: Uint8Array.of(1) }, done: false });
  expect(queue.snapshot().messages).toBe(1);
  await reader.cancel();
  queue.push(message(3));
  expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0 });
  await expect(reader.read()).resolves.toMatchObject({ done: true });
});

test('stream cancellation settles a pending read without enqueue after cancel', async () => {
  const queue = createMessageQueue({ maxMessages: 1, maxBytes: 3 });
  const reader = queue.stream().getReader();
  const pending = reader.read();
  await reader.cancel('not interested');
  await expect(pending).resolves.toMatchObject({ done: true });
  queue.push(message());
  expect(queue.snapshot().messages).toBe(0);
});

test('destination failure cancels only the application facade', async () => {
  const queue = createMessageQueue({ maxMessages: 2, maxBytes: 6 });
  queue.push(message());
  const reason = new Error('sink failed');
  const piping = queue.stream().pipeTo(
    new WritableStream<BrowserMessage>({
      write() {
        throw reason;
      },
    }),
  );
  await expect(piping).rejects.toBe(reason);
  queue.push(message());
  expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0 });
});

test('pipe cancellation releases the facade and preserves its abort reason', async () => {
  const queue = createMessageQueue({ maxMessages: 2, maxBytes: 6 });
  const controller = new AbortController();
  const result = queue
    .stream()
    .pipeTo(new WritableStream(), { signal: controller.signal })
    .catch((reason: unknown) => reason);
  const reason = new Error('cancel application pipe');
  controller.abort(reason);
  await expect(result).resolves.toBe(reason);
  queue.push(message());
  expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0 });
});

test('source failure reaches a pending stream read with the same reason', async () => {
  const queue = createMessageQueue({ maxMessages: 1, maxBytes: 3 });
  const reader = queue.stream().getReader();
  const pending = reader.read().catch((reason: unknown) => reason);
  const reason = new Error('peer ended');
  queue.fail(reason);
  await expect(pending).resolves.toBe(reason);
  await expect(reader.read()).rejects.toBe(reason);
  reader.releaseLock();
  expect(queue.snapshot().bytes).toBe(0);
});

test.each(['close', 'failure'] as const)('source %s settles reader.closed without another read', async (mode) => {
  const queue = createMessageQueue({ maxMessages: 1, maxBytes: 3 });
  const reader = queue.stream().getReader();
  const reason = new Error('source failed while idle');
  let terminal: unknown = 'pending';
  void reader.closed.then(
    () => {
      terminal = 'closed';
    },
    (error: unknown) => {
      terminal = error;
    },
  );
  if (mode === 'close') queue.close();
  else queue.fail(reason);
  await Promise.resolve();
  expect(terminal).toBe(mode === 'close' ? 'closed' : reason);
  reader.releaseLock();
});

test('source close preserves a message handed to a pending stream pull', async () => {
  const queue = createMessageQueue({ maxMessages: 1, maxBytes: 3 });
  const reader = queue.stream().getReader();
  const pending = reader.read();
  await Promise.resolve();
  queue.push(message(9));
  queue.close();
  await expect(pending).resolves.toMatchObject({ value: { payload: Uint8Array.of(9) }, done: false });
  await expect(reader.closed).resolves.toBeUndefined();
  await expect(reader.read()).resolves.toMatchObject({ done: true });
  reader.releaseLock();
});

test('the first source terminal signal preserves an admitted drain', async () => {
  const queue = createMessageQueue({ maxMessages: 1, maxBytes: 3 });
  queue.push(message(8));
  queue.close();
  queue.fail(new Error('late source error'));
  const reader = queue.stream().getReader();
  await expect(reader.read()).resolves.toMatchObject({ value: { payload: Uint8Array.of(8) }, done: false });
  await expect(reader.closed).resolves.toBeUndefined();
  await expect(reader.read()).resolves.toMatchObject({ done: true });
  reader.releaseLock();
});
