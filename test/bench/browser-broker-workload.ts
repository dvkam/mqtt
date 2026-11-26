import { createBrowserClient } from 'mqtt/browser';
import { summarizeLatencies } from '../experiments/latencies.js';

const topic = 'bench/browser/echo';

export async function measureEcho(options: Readonly<{ url: string; qos: 0 | 1; warmup: number; iterations: number }>) {
  const { url, qos, warmup, iterations } = options;
  const controller = new AbortController();
  const decoder = new TextDecoder();
  let expectedPayload = '';
  let echo: (() => void) | undefined;
  let rejectEcho: ((reason: Readonly<Error>) => void) | undefined;
  let echoCount = 0;
  const client = await createBrowserClient({
    url,
    clientId: 'packed-browser-bench',
    signal: controller.signal,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The client hands over a mutable Uint8Array.
    onMessage(message: Readonly<{ topic: string; qos: number; payload: Uint8Array }>) {
      if (
        echo === undefined ||
        message.topic !== topic ||
        message.qos !== 0 ||
        decoder.decode(message.payload) !== expectedPayload
      ) {
        controller.abort(new Error('Unexpected browser broker echo'));
        return;
      }
      echoCount++;
      const received = echo;
      echo = undefined;
      received();
    },
    onSessionEnd(event) {
      if (event.kind === 'error') rejectEcho?.(event.error);
    },
  }).connect();

  const deadline = setTimeout(() => {
    controller.abort(new Error('Browser echo workload timed out'));
  }, 30_000);
  const samples: number[] = [];
  const publishOptions = { qos };
  let startedAt = 0;
  let elapsed = 0;
  try {
    await client.subscribe(topic);
    for (let index = 0; index < warmup + iterations; index++) {
      const started = performance.now();
      if (index === warmup) startedAt = started;
      expectedPayload = String(index);
      const echoed = new Promise<void>((resolve, reject) => {
        echo = resolve;
        rejectEcho = reject;
      });
      await Promise.all([echoed, client.publish(topic, expectedPayload, publishOptions)]);
      rejectEcho = undefined;
      if (controller.signal.aborted) throw new Error('Browser echo failed');
      if (index >= warmup) samples.push(performance.now() - started);
    }
    elapsed = performance.now() - startedAt;
  } finally {
    clearTimeout(deadline);
    await client.disconnect();
  }
  if (echoCount !== warmup + iterations || controller.signal.aborted) throw new Error('Browser echo count or session failed');
  return { qos, warmup, iterations, echoCount, echoPerSecond: (iterations * 1000) / elapsed, echoMs: summarizeLatencies(samples) };
}

export async function measureConnections(url: string, iterations: number) {
  const connect: number[] = [];
  const disconnect: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    const client = await createBrowserClient({ url, clientId: 'packed-browser-connect' }).connect();
    const connected = performance.now();
    connect.push(connected - start);
    await client.disconnect();
    disconnect.push(performance.now() - connected);
  }
  return { firstConnectMs: connect[0], connectMs: summarizeLatencies(connect), disconnectMs: summarizeLatencies(disconnect) };
}
