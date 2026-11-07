import { createBrowserClient } from 'mqtt/browser';
import { createMessageQueue } from '../experiments/message-queue.js';
import { compareDelivery } from '../experiments/delivery-comparison.js';

export async function compareStreams(url: string) {
  const results = [];
  for (const mode of ['callback', 'iterator', 'web-stream'] as const) results.push(await compareDelivery(mode));
  const ownership = [];
  for (const mode of ['iterator-break', 'stream-cancel', 'overflow'] as const) {
    const queue = createMessageQueue({ maxMessages: 1, maxBytes: 40 });
    const client = await createBrowserClient({ url, clientId: mode, onMessage: queue.push }).connect();
    try {
      await client.publish('a', 'first');
      await client.ping();
      let first: string | undefined;
      let failure: unknown;
      if (mode === 'iterator-break') {
        for await (const message of queue.iterate()) {
          first = new TextDecoder().decode(message.payload);
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
          .catch((reason: unknown) => reason);
      }
      await client.publish('a', 'after-stop');
      await client.subscribe('a');
      await client.ping();
      ownership.push({
        mode,
        first: first ?? null,
        failure: failure instanceof Error ? failure.message : null,
        queued: queue.snapshot().messages,
      });
    } finally {
      await client.disconnect();
      queue.close();
    }
  }
  const idle = createMessageQueue({ maxMessages: 1, maxBytes: 3 });
  const idleReader = idle.stream().getReader();
  let idleClosed = false;
  void idleReader.closed.then(() => {
    idleClosed = true;
  });
  idle.close();
  await Promise.resolve();
  idleReader.releaseLock();

  const failed = createMessageQueue({ maxMessages: 1, maxBytes: 3 });
  const failedReader = failed.stream().getReader();
  const reason = new Error('source failed while idle');
  let idleFailure = false;
  void failedReader.closed.catch((error: unknown) => {
    idleFailure = error === reason;
  });
  failed.fail(reason);
  await Promise.resolve();
  failedReader.releaseLock();

  const handoff = createMessageQueue({ maxMessages: 1, maxBytes: 3 });
  const handoffReader = handoff.stream().getReader();
  const pending = handoffReader.read();
  await Promise.resolve();
  handoff.push({ cmd: 'publish', topic: 'a', payload: Uint8Array.of(9), qos: 0, dup: false, retain: false });
  handoff.close();
  const received = await pending;
  const handed = !received.done && received.value.payload[0] === 9;
  await handoffReader.closed;
  handoffReader.releaseLock();
  return { results, ownership, terminal: { idleClosed, idleFailure, handed } };
}
