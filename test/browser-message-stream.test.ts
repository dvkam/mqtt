import { startProtocolPeer } from './experiments/protocol-peer.js';
import { getEventListeners } from 'node:events';
import { expect, test } from 'vitest';
import { createBrowserClient } from '../src/browserClient.js';
import type { SessionEnd } from '../src/session.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createMessageQueue } from './experiments/message-queue.js';

test.each(['iterator-break', 'stream-cancel', 'overflow'] as const)(
  '%s leaves SUBACK, PINGRESP and disconnect processing alive',
  async (mode) => {
    const broker = await startProtocolPeer();
    const queue = createMessageQueue({ maxMessages: 1, maxBytes: 40 });
    const controller = new AbortController();
    try {
      const client = await createBrowserClient({
        url: broker.url,
        clientId: mode,
        onMessage: queue.push,
        signal: controller.signal,
      }).connect();
      await client.publish('a', 'first');
      // A ping reply is ordered after the preceding publication on the same connection.
      await client.ping();
      expect(queue.snapshot().messages).toBe(1);
      let firstPayload: string | undefined;
      let failure: unknown;
      if (mode === 'iterator-break') {
        for await (const message of queue.iterate()) {
          firstPayload = new TextDecoder().decode(message.payload);
          break;
        }
      } else if (mode === 'stream-cancel') {
        await queue.stream().cancel();
      } else {
        await client.publish('a', 'overflow');
        await client.ping();
        failure = await queue
          .iterate()
          .next()
          .catch((error: unknown) => error);
      }
      expect(firstPayload).toBe(mode === 'iterator-break' ? 'first' : undefined);
      expect(failure).toEqual(mode === 'overflow' ? new Error('Application message queue capacity exceeded') : undefined);
      expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0 });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
      await client.publish('a', 'after-stop');
      await client.subscribe('a');
      await client.ping();
      expect(queue.snapshot()).toMatchObject({ messages: 0, bytes: 0 });
      await client.disconnect();
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      queue.close();
      expect(broker.commands).toContain('subscribe');
      expect(broker.commands.filter((command) => command === 'pingreq').length).toBeGreaterThanOrEqual(2);
    } finally {
      queue.close();
      await broker.close();
    }
  },
);

test('a stalled stream does not block control traffic and source close settles its read', async () => {
  const broker = await startProtocolPeer();
  const queue = createMessageQueue({ maxMessages: 2, maxBytes: 40 });
  const reader = queue.stream().getReader();
  try {
    const client = await createBrowserClient({ url: broker.url, clientId: 'stalled', onMessage: queue.push }).connect();
    await client.publish('a', 'one');
    await client.publish('a', 'two');
    await client.subscribe('a');
    await client.ping();
    expect(queue.snapshot().messages).toBe(2);
    await expect(reader.read()).resolves.toMatchObject({ value: { topic: 'a' } });
    await expect(reader.read()).resolves.toMatchObject({ value: { topic: 'a' } });
    const pending = reader.read();
    await client.disconnect();
    queue.close();
    await expect(pending).resolves.toMatchObject({ done: true });
  } finally {
    await reader.cancel();
    await broker.close();
  }
});

test('local disconnect drains the browser queue and closes its stream', async () => {
  const broker = await startProtocolPeer();
  const queue = createMessageQueue({ maxMessages: 2, maxBytes: 40 });
  const reader = queue.stream().getReader();
  try {
    const client = await createBrowserClient({
      url: broker.url,
      clientId: 'browser-queue-drain',
      onMessage: queue.push,
      onSessionEnd: (event: SessionEnd) => {
        if (event.kind === 'disconnect') queue.close();
        else queue.fail(event.error);
      },
    }).connect();
    await client.publish('a', 'one');
    await client.ping();
    await client.disconnect();
    await expect(reader.read()).resolves.toMatchObject({ value: { topic: 'a' } });
    await expect(Promise.race([reader.read(), delay(50, 'source still open')])).resolves.toMatchObject({ done: true });
    await reader.closed;
  } finally {
    queue.close();
    await broker.close();
  }
});

test('aborting the browser session fails its pending queue read with the same error', async () => {
  const broker = await startProtocolPeer();
  const queue = createMessageQueue({ maxMessages: 2, maxBytes: 40 });
  const controller = new AbortController();
  const reader = queue.stream().getReader();
  try {
    const client = await createBrowserClient({
      url: broker.url,
      clientId: 'browser-queue-abort',
      signal: controller.signal,
      onSessionEnd: (event: SessionEnd) => {
        if (event.kind === 'disconnect') queue.close();
        else queue.fail(event.error);
      },
    }).connect();
    const pending = reader.read().catch((error: unknown) => error);
    const closed = reader.closed.catch((error: unknown) => error);
    const failure = new Error('application aborted the session');
    controller.abort(failure);
    await expect(client.ping()).rejects.toBe(failure);
    await expect(Promise.race([pending, delay(50, 'source still open')])).resolves.toBe(failure);
    await expect(closed).resolves.toBe(failure);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  } finally {
    queue.close();
    await broker.close();
  }
});
