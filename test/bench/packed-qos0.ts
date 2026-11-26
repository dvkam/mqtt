import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { createTransportClient, type ByteTransport, type PublishOptions } from 'mqtt';
import { summarizeLatencies } from '../experiments/latencies.ts';

const iterations = Number(process.env['MQTT_TEST_ITERATIONS'] ?? 200_000);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0, 'MQTT_TEST_ITERATIONS must be a positive integer');
const warmup = 10_000;
const heapProfile = process.env['MQTT_QOS0_HEAP_PROFILE'];
const countTimers = process.env['MQTT_TEST_TIMER_COUNT'] === '1';
assert.ok(heapProfile === undefined || !countTimers, 'Use separate runs for heap sampling and timer counts');
const workload = process.env['MQTT_QOS0_WORKLOAD'] ?? 'text';
assert.ok(
  workload === 'text' || workload === 'bytes' || workload === 'properties',
  'MQTT_QOS0_WORKLOAD must be text, bytes or properties',
);
const text = '1234567890abcdef';
const payload = workload === 'text' ? text : new TextEncoder().encode(text);
const topic = 'bench/qos0';
// Content Type 'bin' (6 bytes), Correlation Data of 4 bytes (7 bytes) and one User Property 'k' = 'v' (7 bytes).
const options: PublishOptions | undefined =
  workload === 'properties'
    ? { contentType: 'bin', correlationData: Uint8Array.of(1, 2, 3, 4), userProperties: [['k', 'v']] }
    : undefined;
const properties =
  workload === 'properties' ? [0x26, 0, 1, 0x6b, 0, 1, 0x76, 0x03, 0, 3, ...Buffer.from('bin'), 0x09, 0, 4, 1, 2, 3, 4] : [];
const expected = Uint8Array.of(
  0x30,
  29 + properties.length,
  0,
  10,
  ...Buffer.from(topic),
  properties.length,
  ...properties,
  ...Buffer.from(text),
);
const completed = Promise.resolve();
let publications = 0;
let byteCount = 0;
const transport: ByteTransport = {
  name: 'benchmark writer',
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The packed writer retains the inbound interface and opens synchronously.
  async open(inbound) {
    return {
      bufferedBytes: 0,
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/promise-function-async -- Return one settled write promise so the fixture adds no promise allocation per packet.
      write(bytes) {
        const header = bytes[0];
        if (header === 0x10) inbound.bytes(Uint8Array.of(0x20, 3, 0, 0, 0));
        else if (header === 0x30) {
          if ((publications & 1023) === 0) assert.deepEqual(bytes, expected);
          publications++;
          byteCount += bytes.length;
        } else if (header === 0xe0) assert.equal(bytes[1], 0);
        else throw new Error('Unexpected packet');
        return completed;
      },
      // oxlint-disable-next-line typescript/promise-function-async -- Reuse the settled fixture promise to close.
      close: (force) => {
        assert.equal(force, false);
        return completed;
      },
    };
  },
};

const client = await createTransportClient(transport, { clientId: 'packed-qos0-bench' }).connect();
const originalTimer = globalThis.setTimeout;
let timerCalls = 0;
let profiler: Session | undefined;
try {
  for (let index = 0; index < warmup; index++) await client.publish(topic, payload, options);
  if (countTimers) {
    globalThis.setTimeout = new Proxy(originalTimer, {
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The proxy forwards a native timer call with its original receiver and arguments.
      apply(schedule, receiver: unknown, args: readonly unknown[]) {
        timerCalls++;
        const result: unknown = Reflect.apply(schedule, receiver, args);
        return result;
      },
    });
  }
  if (heapProfile !== undefined) {
    profiler = new Session();
    profiler.connect();
    await profiler.post('HeapProfiler.startSampling', {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const samples: number[] = [];
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    await client.publish(topic, payload, options);
    if (heapProfile === undefined) samples.push(performance.now() - started);
  }
  const elapsed = performance.now() - start;
  assert.equal(publications, warmup + iterations);
  assert.equal(byteCount, (warmup + iterations) * expected.length);
  const observation = { node: process.version, v8: process.versions.v8, workload, warmup, iterations, publications, byteCount };
  if (heapProfile !== undefined && profiler !== undefined) {
    const { profile } = await profiler.post('HeapProfiler.stopSampling');
    writeFileSync(heapProfile, JSON.stringify(profile));
    assert.ok('samples' in profile && Array.isArray(profile.samples));
    const samples: readonly unknown[] = profile.samples;
    const sampledBytes = samples.reduce((total: number, sample) => {
      assert.ok(typeof sample === 'object' && sample !== null && 'size' in sample && typeof sample.size === 'number');
      return total + sample.size;
    }, 0);
    assert.ok(sampledBytes > 0);
    console.log(JSON.stringify({ ...observation, sampledBytes, sampledBytesPerPublish: sampledBytes / iterations }));
  } else {
    console.log(
      JSON.stringify({
        ...observation,
        publicationsPerSecond: (iterations * 1000) / elapsed,
        latencyMs: summarizeLatencies(samples),
        timerCalls: countTimers ? timerCalls : undefined,
      }),
    );
  }
} finally {
  profiler?.disconnect();
  globalThis.setTimeout = originalTimer;
  await client.disconnect();
}
