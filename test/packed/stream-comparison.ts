import { createBrowserClient, type SessionEndObserver } from 'mqtt/browser';
import { createMessageQueue } from '../experiments/message-queue.js';
import { compareDelivery } from '../experiments/delivery-comparison.js';

export async function compareStreams(url: string) {
  const results = [];
  for (const mode of ['callback', 'iterator', 'web-stream'] as const) results.push(await compareDelivery(mode));
  const ownership = [];
  for (const mode of ['iterator-break', 'stream-cancel', 'overflow'] as const) {
    const queue = createMessageQueue({ maxMessages: 1, maxBytes: 40 });
    const client = await createBrowserClient({
      url,
      clientId: mode,
      onMessage: queue.push,
      onSessionEnd: bindQueueEnd(queue),
    }).connect();
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
    }
  }
  const draining = createMessageQueue({ maxMessages: 1, maxBytes: 40 });
  const drainingClient = await createBrowserClient({
    url,
    clientId: 'stream-source-drain',
    onMessage: draining.push,
    onSessionEnd: bindQueueEnd(draining),
  }).connect();
  await drainingClient.publish('a', 'drain');
  await drainingClient.ping();
  await drainingClient.disconnect();
  const reader = draining.stream().getReader();
  const item = await reader.read();
  const drained = !item.done && new TextDecoder().decode(item.value.payload) === 'drain' && (await reader.read()).done;
  await reader.closed;
  reader.releaseLock();

  const failed = createMessageQueue({ maxMessages: 1, maxBytes: 3 });
  const controller = new AbortController();
  const failedClient = await createBrowserClient({
    url,
    clientId: 'stream-source-abort',
    signal: controller.signal,
    onSessionEnd: bindQueueEnd(failed),
  }).connect();
  const failedReader = failed.stream().getReader();
  const readResult = failedReader.read().catch((error: unknown) => error);
  const closedResult = failedReader.closed.catch((error: unknown) => error);
  const reason = new Error('source aborted while waiting');
  controller.abort(reason);
  const pingResult = await failedClient.ping().catch((error: unknown) => error);
  const abortObserved = pingResult === reason && (await readResult) === reason && (await closedResult) === reason;
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
  return { results, ownership, terminal: { drained, abortObserved, handed } };
}

function bindQueueEnd(queue: Readonly<Pick<ReturnType<typeof createMessageQueue>, 'close' | 'fail'>>): SessionEndObserver {
  return (event) => {
    if (event.kind === 'disconnect') queue.close();
    else queue.fail(event.error);
  };
}
