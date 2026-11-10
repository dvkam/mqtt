import { createBrowserClient, type ClientSession, type SessionEnd } from 'mqtt/browser';
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
  const handlerFailure = await probeHandlerFailure(url);
  return {
    results,
    ownership,
    terminal: { drained, abortObserved, handed, handlerFailure },
    cancellation: await probeCancellation(url),
    stalledQosOne: await probeStalledQosOne(url),
  };
}

function bindQueueEnd(queue: Readonly<Pick<ReturnType<typeof createMessageQueue>, 'close' | 'fail'>>): (event: SessionEnd) => void {
  return (event) => {
    if (event.kind === 'disconnect') queue.close();
    else queue.fail(event.error);
  };
}

const cancellationModes = [
  'iterator-return',
  'iterator-throw',
  'destination-failure',
  'pipe-abort',
  'cancel-during-disconnect',
  'cancel-after-source-close',
] as const;
type CancellationMode = (typeof cancellationModes)[number];
type ApplicationQueue = Readonly<Pick<ReturnType<typeof createMessageQueue>, 'iterate' | 'stream' | 'snapshot'>>;
type SessionControl = Readonly<Pick<ClientSession, 'publish' | 'subscribe' | 'ping' | 'disconnect'>>;

async function probeCancellation(url: string) {
  const results = [];
  for (const mode of cancellationModes) {
    const queue = createMessageQueue({ maxMessages: 2, maxBytes: 64 });
    const ends: SessionEnd[] = [];
    let signalRetired = () => {};
    const retired = new Promise<void>((resolve) => {
      signalRetired = resolve;
    });
    const handleEnd = bindQueueEnd(queue);
    const client = await createBrowserClient({
      url,
      clientId: mode,
      onMessage: queue.push,
      onSessionEnd(event) {
        handleEnd(event);
        ends.push(event);
        signalRetired();
      },
    }).connect();
    let consumerSettled: boolean;
    try {
      await client.subscribe('a');
      await client.ping();
      if (mode === 'cancel-during-disconnect' || mode === 'cancel-after-source-close') {
        await client.publish('a', 'before-close', { qos: 1 });
        consumerSettled = await cancelAtDisconnect(mode, queue, client, retired);
      } else {
        consumerSettled = await cancelWhileActive(mode, queue, client);
        await client.publish('a', 'after-stop');
        await Promise.all([client.subscribe('a'), client.publish('a', 'control', { qos: 1 }), client.ping()]);
      }
    } finally {
      await client.disconnect();
    }
    const { messages, bytes } = queue.snapshot();
    results.push({
      mode,
      consumerSettled,
      retiredOnce: ends.length === 1 && ends[0]?.kind === 'disconnect',
      empty: messages === 0 && bytes === 0,
    });
  }
  return results;
}

async function cancelWhileActive(
  mode: Exclude<CancellationMode, 'cancel-during-disconnect' | 'cancel-after-source-close'>,
  queue: ApplicationQueue,
  client: SessionControl,
): Promise<boolean> {
  const reason = new Error(mode);
  if (mode === 'iterator-return' || mode === 'iterator-throw') {
    const iterator = queue.iterate();
    const pending = iterator.next();
    if (mode === 'iterator-return') {
      const result = await iterator.return?.();
      return result?.done === true && (await pending).done === true;
    }
    const result = await iterator.throw?.(reason).catch((error: unknown) => error);
    return result === reason && (await pending).done === true;
  }

  const source = queue.stream();
  const controller = new AbortController();
  let abortedWith: unknown;
  const destination = new WritableStream<unknown>({
    write() {
      if (mode === 'destination-failure') throw reason;
    },
    abort(error: unknown) {
      abortedWith = error;
    },
  });
  const result = source.pipeTo(destination, { signal: controller.signal }).catch((error: unknown) => error);
  if (mode === 'destination-failure') await client.publish('a', 'sink-input');
  else {
    await client.ping();
    controller.abort(reason);
  }
  return (await result) === reason && !source.locked && !destination.locked && (mode !== 'pipe-abort' || abortedWith === reason);
}

async function cancelAtDisconnect(
  mode: 'cancel-during-disconnect' | 'cancel-after-source-close',
  queue: ApplicationQueue,
  client: SessionControl,
  retired: Readonly<PromiseLike<void>>,
): Promise<boolean> {
  const reader = queue.stream().getReader();
  try {
    if (mode === 'cancel-after-source-close') {
      await client.publish('a', 'queued');
      await client.ping();
      const disconnecting = client.disconnect();
      const repeated = client.disconnect();
      await retired;
      const stillQueued = queue.snapshot().messages === 1;
      await reader.cancel();
      await Promise.all([reader.closed, disconnecting]);
      return disconnecting === repeated && stillQueued && (await reader.read()).done;
    }
    const pending = reader.read();
    const disconnecting = client.disconnect();
    const repeated = client.disconnect();
    await Promise.all([reader.cancel(), reader.closed, disconnecting]);
    return disconnecting === repeated && (await pending).done;
  } finally {
    reader.releaseLock();
  }
}

async function probeHandlerFailure(url: string): Promise<boolean> {
  const queue = createMessageQueue({ maxMessages: 1, maxBytes: 40 });
  const failure = new Error('MQTT message handler failed');
  const ends: SessionEnd[] = [];
  const handleEnd = bindQueueEnd(queue);
  const client = await createBrowserClient({
    url,
    clientId: 'stream-handler-failure',
    onMessage() {
      throw failure;
    },
    onSessionEnd(event) {
      handleEnd(event);
      ends.push(event);
    },
  }).connect();
  const reader = queue.stream().getReader();
  const readResult = reader.read().catch((error: unknown) => error);
  const closedResult = reader.closed.catch((error: unknown) => error);
  try {
    await client.subscribe('a');
    const sent = client.publish('a', 'handler-input');
    const pingResult = client.ping().catch((error: unknown) => error);
    await sent;
    const outcomes = await Promise.all([pingResult, readResult, closedResult]);
    const event = ends[0];
    return (
      outcomes.every((outcome) => outcome === failure) && ends.length === 1 && event?.kind === 'error' && event.error === failure
    );
  } finally {
    await client.disconnect().catch(() => {});
    reader.releaseLock();
  }
}

async function probeStalledQosOne(url: string) {
  const queue = createMessageQueue({ maxMessages: 1, maxBytes: 40 });
  const entered = completion();
  const release = completion();
  const acknowledged = completion();
  const received: boolean[] = [];
  const acknowledgments: boolean[] = [];
  let handlerFinished = false;
  const client = await createBrowserClient({
    url,
    clientId: 'stream-stalled-qos-one',
    onMessage: queue.push,
    onSessionEnd: bindQueueEnd(queue),
    async onQosOneMessage(packet: Readonly<{ topic: string; messageId: number; payload: Readonly<{ byteLength: number }> }>) {
      received.push(packet.topic === 'control/inbound' && packet.messageId === 23 && packet.payload.byteLength === 3);
      entered.finish();
      await release.promise;
      handlerFinished = true;
    },
    onDiagnostic(event) {
      if (event.kind === 'packet' && event.direction === 'outbound' && event.command === 'puback') {
        acknowledgments.push(handlerFinished);
        acknowledged.finish();
      }
    },
  }).connect();
  const reader = queue.stream().getReader();
  try {
    await client.subscribe('a');
    await client.publish('a', 'queued');
    await client.ping();
    const initiallyQueued = queue.snapshot().messages === 1;
    await client.subscribe('control/inbound', { qos: 1 });
    await entered.promise;
    await client.ping();
    const heldBeforeRelease = initiallyQueued && queue.snapshot().messages === 1 && acknowledgments.length === 0;
    release.finish();
    await acknowledged.promise;
    await client.ping();
    await reader.cancel();
    const { messages, bytes } = queue.snapshot();
    return {
      received: received.length === 1 && received[0] === true,
      heldBeforeRelease,
      acknowledged: acknowledgments.length === 1 && acknowledgments[0] === true,
      queueCleared: messages === 0 && bytes === 0,
    };
  } finally {
    release.finish();
    reader.releaseLock();
    await client.disconnect();
  }
}

function completion() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

export { probeSustained } from './sustained-client.js';
