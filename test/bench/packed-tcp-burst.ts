import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { createTcpClient } from 'mqtt';
import { summarizeLatencies } from '../experiments/latencies.ts';

const port = Number(process.env['MQTT_TEST_PORT']);
assert.ok(Number.isInteger(port) && port > 0, 'Set MQTT_TEST_PORT to the disposable broker port');
const bursts = Number(process.env['MQTT_TEST_BURSTS'] ?? 50);
const warmup = Number(process.env['MQTT_BURST_WARMUP'] ?? 5);
assert.ok(Number.isSafeInteger(bursts) && bursts > 0 && Number.isSafeInteger(warmup) && warmup >= 0);
const caPath = process.env['MQTT_TEST_CA'];
const tls = caPath === undefined ? undefined : { ca: readFileSync(caPath) };
const observeResources = process.env['MQTT_TEST_RESOURCES'] === '1';
const count = 1000;
const topic = 'bench/tcp-burst';

type Burst = {
  readonly first: number;
  readonly starts: number[];
  readonly echoes: number[];
  readonly finish: () => void;
  readonly fail: (reason: Readonly<Error>) => void;
};
let active: Burst | undefined;
const connectionStart = performance.now();
const client = await createTcpClient({
  host: tls === undefined ? '127.0.0.1' : 'localhost',
  port,
  tls,
  clientId: 'packed-tcp-burst',
  maxPendingPublishes: count,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The packet carries the original mutable Buffer.
  onMessage(packet) {
    const burst = active;
    if (burst === undefined || packet.topic !== topic) throw new Error('Unexpected burst echo');
    const index = burst.echoes.length;
    const sent = burst.starts[index];
    if (sent === undefined || packet.payload.toString() !== String(burst.first + index))
      throw new Error('Burst echoes were missing, repeated, corrupted, or out of order');
    burst.echoes.push(performance.now() - sent);
    if (burst.echoes.length === count) burst.finish();
  },
  onSessionEnd(outcome) {
    if (outcome.kind === 'error') active?.fail(outcome.error);
  },
}).connect();
const connectMs = performance.now() - connectionStart;

async function runBurst(first: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const echoed = new Promise<void>((resolve, reject) => {
    active = { first, starts: [], echoes: [], finish: resolve, fail: reject };
    timer = setTimeout(() => {
      reject(new Error('Timed out waiting for burst echoes'));
    }, 10_000);
  });
  const burst = active;
  assert.ok(burst !== undefined);
  const sent: Promise<void>[] = [];
  try {
    const started = performance.now();
    for (let index = 0; index < count; index++) {
      burst.starts.push(performance.now());
      sent.push(client.publish(topic, String(first + index)));
    }
    await Promise.all([echoed, Promise.all(sent)]);
    assert.equal(burst.echoes.length, count);
    return { elapsedMs: performance.now() - started, echoes: burst.echoes };
  } finally {
    clearTimeout(timer);
    active = undefined;
  }
}

const echoSamples: number[] = [];
const burstSamples: number[] = [];
const loopDelay = observeResources ? monitorEventLoopDelay({ resolution: 1 }) : undefined;
let before: NodeJS.MemoryUsage | undefined;
let retained: NodeJS.MemoryUsage | undefined;
let elapsedMs = 0;
let cpu: NodeJS.CpuUsage | undefined;
let disconnectMs = 0;
try {
  await client.subscribe(topic);
  for (let index = 0; index < warmup; index++) await runBurst(index * count);
  if (observeResources) {
    assert.ok(globalThis.gc !== undefined, 'Use --expose-gc for resource observations');
    globalThis.gc();
    before = process.memoryUsage();
    loopDelay?.enable();
    await setImmediate();
  }
  const start = performance.now();
  const cpuStart = observeResources ? process.cpuUsage() : undefined;
  for (let index = 0; index < bursts; index++) {
    const burst = await runBurst((warmup + index) * count);
    echoSamples.push(...burst.echoes);
    burstSamples.push(burst.elapsedMs);
  }
  elapsedMs = performance.now() - start;
  if (cpuStart !== undefined) cpu = process.cpuUsage(cpuStart);
} finally {
  loopDelay?.disable();
  const closing = performance.now();
  await client.disconnect();
  disconnectMs = performance.now() - closing;
}
const echoMs = summarizeLatencies(echoSamples);
const burstMs = summarizeLatencies(burstSamples);
assert.equal(echoMs.count, count * bursts);
if (observeResources) {
  echoSamples.length = 0;
  burstSamples.length = 0;
  await setImmediate();
  globalThis.gc?.();
  retained = process.memoryUsage();
}
console.log(
  JSON.stringify({
    node: process.version,
    v8: process.versions.v8,
    transport: tls === undefined ? 'tcp' : 'tls',
    count,
    bursts,
    warmup,
    connectMs,
    disconnectMs,
    echoPerSecond: (count * bursts * 1000) / elapsedMs,
    echoMs,
    burstMs,
    resources:
      loopDelay === undefined
        ? undefined
        : {
            cpu,
            before,
            retained,
            loopDelayMs: {
              samples: loopDelay.count,
              p50: loopDelay.percentile(50) / 1e6,
              p90: loopDelay.percentile(90) / 1e6,
              p95: loopDelay.percentile(95) / 1e6,
              p99: loopDelay.percentile(99) / 1e6,
              maximum: loopDelay.max / 1e6,
            },
          },
  }),
);
