import { startProtocolPeer } from './experiments/protocol-peer.js';
import { getEventListeners } from 'node:events';
import { expect, test } from 'vitest';
import { createBrowserClient } from '../src/browserClient.js';
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
