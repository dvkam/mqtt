import type { DeliveryMode } from './delivery-comparison.ts';
import { createMessageQueue } from './message-queue.ts';

export interface FixedRatePlan {
  readonly burstCount: number;
  readonly burstSize: number;
  readonly periodMs: number;
  readonly queueLimit: number;
}

interface DeliveryClock {
  readonly now: () => number;
  readonly waitUntil: (deadline: number) => Promise<void>;
}

const batchLimits = { 'batch-1': 1, 'batch-4': 4, 'batch-16': 16 } as const;
export type FixedRateMode = DeliveryMode | keyof typeof batchLimits;

export function isFixedRateMode(mode: unknown): mode is FixedRateMode {
  return (
    mode === 'callback' ||
    mode === 'iterator' ||
    mode === 'web-stream' ||
    mode === 'batch-1' ||
    mode === 'batch-4' ||
    mode === 'batch-16'
  );
}

function batchLimit(mode: FixedRateMode) {
  return mode === 'callback' || mode === 'iterator' || mode === 'web-stream' ? 1 : batchLimits[mode];
}

const payloadBytes = 256;
const messageWeight = payloadBytes + 2;
const realtimeClock: DeliveryClock = {
  now: () => performance.now(),
  async waitUntil(deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, Math.ceil(deadline - performance.now())));
    });
  },
};

export const fixedRatePlans = {
  shallow: { burstCount: 128, burstSize: 16, periodMs: 8, queueLimit: 16 },
  deep: { burstCount: 32, burstSize: 128, periodMs: 12, queueLimit: 128 },
} as const;

export async function runFixedRateDelivery(mode: FixedRateMode, plan: FixedRatePlan, clock: DeliveryClock = realtimeClock) {
  const { burstCount, burstSize, periodMs, queueLimit } = plan;
  const count = burstCount * burstSize;
  const queue =
    mode === 'callback' ? undefined : createMessageQueue({ maxMessages: queueLimit, maxBytes: queueLimit * messageWeight });
  const offeredAt = new Float64Array(count);
  const scheduleDelays: number[] = [];
  const queueAges: number[] = [];
  let received = 0;
  let checksum = 0;
  let ordered = true;
  const consume = (message: Readonly<{ payload: unknown }>) => {
    if (!(message.payload instanceof Uint8Array)) throw new Error('Expected fixed-rate payload bytes');
    const { buffer, byteOffset, byteLength } = message.payload;
    const sequence = new DataView(buffer, byteOffset, byteLength).getUint32(0);
    ordered &&= sequence === received;
    checksum += sequence;
    const age = clock.now() - (offeredAt[sequence] ?? 0);
    queueAges.push(age);
    received++;
    return age;
  };
  const consuming = consumeQueue(mode, queue, consume).then(
    (batches) => ({ batches, failure: null }),
    (error: unknown) => ({ batches: undefined, failure: error instanceof Error ? error.message : 'Unexpected consumer failure' }),
  );
  const start = clock.now();
  let offered = 0;
  let outcome: Awaited<typeof consuming>;
  try {
    for (let burst = 1; burst <= burstCount; burst++) {
      const deadline = start + burst * periodMs;
      await clock.waitUntil(deadline);
      scheduleDelays.push(clock.now() - deadline);
      for (let item = 0; item < burstSize; item++) {
        const payload = new Uint8Array(payloadBytes);
        new DataView(payload.buffer).setUint32(0, offered);
        const message = { cmd: 'publish', topic: 'a', payload, qos: 0, dup: false, retain: false } as const;
        offeredAt[offered] = clock.now();
        offered++;
        if (queue === undefined) consume(message);
        else queue.push(message);
      }
    }
  } finally {
    queue?.close();
    outcome = await consuming;
  }
  const elapsedMs = clock.now() - start;
  scheduleDelays.sort((left, right) => left - right);
  queueAges.sort((left, right) => left - right);
  const snapshot = queue?.snapshot();
  const { batches, failure } = outcome;
  return {
    mode,
    offered,
    received,
    ordered,
    checksum,
    elapsedMs,
    p99ScheduleDelayMs: p99OfSorted(scheduleDelays),
    p99QueueAgeMs: p99OfSorted(queueAges),
    dispatches: batches?.dispatches ?? received,
    peakBatchMessages: batches?.peakBatchMessages ?? (received > 0 ? 1 : 0),
    p99BatchOldestAgeMs: batches?.p99OldestAgeMs ?? p99OfSorted(queueAges),
    pending: snapshot?.messages ?? 0,
    pendingBytes: snapshot?.bytes ?? 0,
    peakMessages: snapshot?.peakMessages ?? 0,
    peakBytes: snapshot?.peakBytes ?? 0,
    failure,
  };
}

type FixedRateResult = Awaited<ReturnType<typeof runFixedRateDelivery>>;

export function assertFixedRateDelivery(result: Readonly<FixedRateResult>, plan: FixedRatePlan): void {
  const count = plan.burstCount * plan.burstSize;
  if (
    result.failure !== null ||
    result.offered !== count ||
    result.received !== count ||
    !result.ordered ||
    result.checksum !== (count * (count - 1)) / 2 ||
    result.pending !== 0 ||
    result.pendingBytes !== 0 ||
    result.peakMessages > plan.queueLimit ||
    result.peakBytes > plan.queueLimit * messageWeight ||
    result.peakBatchMessages > batchLimit(result.mode) ||
    result.peakBatchMessages * messageWeight > plan.queueLimit * messageWeight ||
    result.dispatches * batchLimit(result.mode) < result.received ||
    result.dispatches > result.received
  ) {
    throw new Error('Fixed-rate delivery gate rejected the observation ' + JSON.stringify(result));
  }
}

type BatchStats = Readonly<{ dispatches: number; peakBatchMessages: number; p99OldestAgeMs: number }>;

async function consumeQueue(
  mode: FixedRateMode,
  queue: Readonly<Pick<ReturnType<typeof createMessageQueue>, 'iterate' | 'stream' | 'iterateBatches'>> | undefined,
  consume: (message: Readonly<{ payload: unknown }>) => number,
): Promise<BatchStats | undefined> {
  if (queue === undefined) return undefined;
  if (mode === 'iterator') {
    for await (const message of queue.iterate()) consume(message);
    return undefined;
  }
  if (mode !== 'web-stream') {
    let dispatches = 0;
    let peakBatchMessages = 0;
    const oldestAges: number[] = [];
    for await (const batch of queue.iterateBatches(batchLimit(mode))) {
      dispatches++;
      peakBatchMessages = Math.max(peakBatchMessages, batch.length);
      let oldest: number | undefined;
      for (const message of batch) {
        const age = consume(message);
        oldest ??= age;
      }
      if (oldest !== undefined) oldestAges.push(oldest);
    }
    oldestAges.sort((left, right) => left - right);
    return { dispatches, peakBatchMessages, p99OldestAgeMs: p99OfSorted(oldestAges) };
  }
  const reader = queue.stream().getReader();
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return undefined;
      consume(item.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function p99OfSorted(values: readonly number[]) {
  return values[Math.max(0, Math.ceil(values.length * 0.99) - 1)] ?? 0;
}
