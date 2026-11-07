import type { BrowserMessage } from '../../src/browserClient.js';
import { createMessageQueue } from './message-queue.js';

export type DeliveryMode = 'callback' | 'iterator' | 'web-stream';

export async function compareDelivery(mode: DeliveryMode, count = 2000, payloadBytes = 256) {
  const batchSize = 16;
  const queue =
    mode === 'callback' ? undefined : createMessageQueue({ maxMessages: batchSize, maxBytes: batchSize * (payloadBytes + 2) });
  const started = new Float64Array(count);
  const latencies: number[] = [];
  let received = 0;
  let ordered = true;
  let checksum = 0;
  let acknowledge: (() => void) | undefined;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- All modes consume the same native mutable publication contract.
  const consume = (message: Readonly<BrowserMessage>) => {
    const sequence = new DataView(message.payload.buffer, message.payload.byteOffset, message.payload.byteLength).getUint32(0);
    ordered &&= sequence === received;
    checksum += sequence;
    latencies.push(performance.now() - (started[sequence] ?? 0));
    received++;
    if (received % batchSize === 0 || received === count) acknowledge?.();
  };
  const consuming = (async () => {
    if (queue === undefined) return;
    if (mode === 'iterator') {
      for await (const message of queue.iterate()) consume(message);
    } else {
      const reader = queue.stream().getReader();
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          consume(result.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
  })();
  const beginning = performance.now();
  for (let offset = 0; offset < count; offset += batchSize) {
    const consumed = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    for (let index = offset; index < Math.min(offset + batchSize, count); index++) {
      const payload = new Uint8Array(payloadBytes);
      new DataView(payload.buffer).setUint32(0, index);
      const message: BrowserMessage = { cmd: 'publish', topic: 'a', payload, qos: 0, dup: false, retain: false };
      started[index] = performance.now();
      if (queue === undefined) consume(message);
      else queue.push(message);
    }
    await consumed;
  }
  queue?.close();
  await consuming;
  const elapsedMs = performance.now() - beginning;
  latencies.sort((left, right) => left - right);
  return {
    mode,
    attempted: count,
    received,
    ordered,
    checksum,
    elapsedMs,
    messagesPerSecond: (count / elapsedMs) * 1000,
    p99DeliveryMs: latencies[Math.max(0, Math.ceil(count * 0.99) - 1)] ?? 0,
    peakMessages: queue?.snapshot().peakMessages ?? 0,
    peakBytes: queue?.snapshot().peakBytes ?? 0,
  };
}
