import { createBrowserClient, type BrowserMessage, type SessionEnd } from 'mqtt/browser';
import { createMessageQueue } from '../experiments/message-queue.js';
import { observeBrowserResources } from './sustained-resources.js';

const retirementModes = ['local', 'abort', 'remote', 'timeout'] as const;
type RetirementMode = (typeof retirementModes)[number];

export async function probeSustained(url: string) {
  const results = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const mode of retirementModes) results.push({ cycle, mode, ...(await probeSession(url, mode)) });
  }
  return results;
}

async function probeSession(url: string, mode: RetirementMode) {
  const controller = new AbortController();
  const resources = observeBrowserResources(controller.signal);
  try {
    return await runSession(url, mode, controller, resources);
  } finally {
    resources.restore();
  }
}

async function runSession(
  url: string,
  mode: RetirementMode,
  controller: Readonly<{ signal: Readonly<AbortSignal>; abort: (reason: unknown) => void }>,
  resources: Readonly<ReturnType<typeof observeBrowserResources>>,
) {
  const queue = createMessageQueue({ maxMessages: 64, maxBytes: 64 * 19 });
  const started = completion();
  const midpoint = completion();
  const ended = completion();
  const retired = completion();
  const ends: SessionEnd[] = [];
  let received = 0;
  let checksum = 0;
  let ordered = true;
  const client = await createBrowserClient({
    url,
    clientId: 'sustained-' + mode,
    signal: controller.signal,
    timeoutMs: 1000,
    onMessage(packet: Readonly<Omit<BrowserMessage, 'payload'>> & Readonly<{ payload: unknown }>) {
      if (packet.topic === 'load/midpoint') midpoint.finish();
      if (packet.topic === 'load/end') ended.finish();
      if (packet.topic !== 'load/data') return;
      if (!(packet.payload instanceof Uint8Array)) throw new Error('Expected sustained publication bytes');
      const sequence = packet.payload[0] ?? -1;
      ordered &&= sequence === received;
      received++;
      checksum += sequence;
      queue.push({ ...packet, payload: packet.payload });
      if (received === 8) started.finish();
    },
    onSessionEnd(event) {
      if (event.kind === 'disconnect') queue.close();
      else queue.fail(event.error);
      ends.push(event);
      retired.finish();
    },
  }).connect();
  const closed = resources.nativeClosed();
  const active = resources.snapshot();
  try {
    await client.subscribe('load/start');
    await started.promise;
    const firstBacklog = queue.snapshot().messages >= 8;
    await Promise.all([client.subscribe('load/control'), client.publish('load/control', '', { qos: 1 }), client.ping()]);
    await midpoint.promise;
    const atMidpoint = queue.snapshot();
    const midpointBacklog = atMidpoint.messages === 64 && atMidpoint.bytes === 64 * 19;
    const ping = client.ping();
    const armed = resources.snapshot().timers === 1;
    await ping;
    const idle = resources.snapshot().timers === 0;

    let delivery: Promise<boolean> | undefined;
    if (mode === 'local') delivery = drain(queue);
    const cancelledIterator = mode === 'abort' ? queue.iterate() : undefined;
    const cancelled = await cancelledIterator?.return?.();
    const afterCancellation = queue.snapshot();
    await client.publish('load/resume', '');
    await ended.promise;
    await Promise.all([client.publish('load/control', '', { qos: 1 }), client.ping()]);

    let applicationOutcome = true;
    if (cancelledIterator !== undefined) {
      const afterBurst = await cancelledIterator.next().catch(() => undefined);
      applicationOutcome =
        cancelled?.done === true && afterCancellation.messages === 0 && afterCancellation.bytes === 0 && afterBurst?.done === true;
    }
    if (mode === 'remote' || mode === 'timeout') {
      const failure = await queue
        .iterate()
        .next()
        .catch((error: unknown) => error);
      applicationOutcome = failure instanceof Error && failure.message === 'Application message queue capacity exceeded';
    }
    const abortReason = new Error('sustained session aborted');
    if (mode === 'local') await client.disconnect();
    if (mode === 'abort') controller.abort(abortReason);
    if (mode === 'remote') await client.publish('load/close', '').catch(() => {});
    let timedOut = true;
    if (mode === 'timeout') {
      await client.publish('load/timeout', '');
      const error = await client.ping().catch((reason: unknown) => reason);
      timedOut = error instanceof Error && error.message === 'MQTT operation timed out';
    }
    await Promise.all([retired.promise, closed]);
    await resources.nextTask();

    const event = ends[0];
    const settled = resources.snapshot();
    const reason = event?.kind === 'error' ? event.error : undefined;
    const expectedEnd =
      mode === 'local'
        ? event?.kind === 'disconnect' && (await delivery) === true
        : mode === 'abort'
          ? reason === abortReason
          : mode === 'remote'
            ? reason?.message === 'MQTT WebSocket closed'
            : reason?.message === 'MQTT operation timed out' && timedOut;
    const finalQueue = queue.snapshot();
    return {
      received,
      ordered,
      checksum,
      controls: firstBacklog && midpointBacklog,
      outcome: applicationOutcome && expectedEnd && ends.length === 1 && finalQueue.messages === 0 && finalQueue.bytes === 0,
      active,
      settled,
      armed,
      idle,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function drain(queue: Readonly<Pick<ReturnType<typeof createMessageQueue>, 'stream'>>) {
  const reader = queue.stream().getReader();
  let count = 0;
  let ordered = true;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return count === 128 && ordered;
      ordered &&= item.value.payload[0] === count;
      count++;
    }
  } finally {
    reader.releaseLock();
  }
}

function completion() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

export async function probeNativeAdmission(url: string) {
  const client = await createBrowserClient({
    url,
    clientId: 'packed-qos-one-budget',
    maxBufferedBytes: 64,
    reservedControlBytes: 16,
    maxPendingPublishes: 1,
  }).connect();
  try {
    const refused = await client.publish('a', 'x'.repeat(80), { qos: 1 }).catch((error: unknown) => error);
    await client.ping();
    await client.publish('a', 'admitted', { qos: 1 });
    await client.ping();
    return refused instanceof Error ? refused.message : null;
  } finally {
    await client.disconnect().catch(() => {});
  }
}
