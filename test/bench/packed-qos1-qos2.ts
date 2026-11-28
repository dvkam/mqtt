import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { createSessionState, createTransportClient, type ByteInbound, type ByteTransport } from 'mqtt';
import { summarizeLatencies } from '../experiments/latencies.ts';

// An in-memory QoS 1 or QoS 2 publish loop. The writer answers each PUBLISH and PUBREL at once, so the numbers show the
// client's own cost per exchange. `test/bench/packed-qos0.ts` is the QoS 0 counterpart and shares its environment names.
const iterations = Number(process.env['MQTT_TEST_ITERATIONS'] ?? 200_000);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0, 'MQTT_TEST_ITERATIONS must be a positive integer');
const level = process.env['MQTT_TEST_QOS'] ?? '1';
assert.ok(level === '1' || level === '2', 'MQTT_TEST_QOS must be 1 or 2');
const qos = level === '1' ? 1 : 2;
const withState = process.env['MQTT_TEST_SESSION_STATE'] === '1';
const heapProfile = process.env['MQTT_QOS0_HEAP_PROFILE'];
const warmup = 10_000;
const payload = '1234567890abcdef';
const topic = 'bench/qos';
const identifierOffset = 4 + topic.length;
const completed = Promise.resolve();
let publications = 0;
let releases = 0;
const transport: ByteTransport = {
  name: 'benchmark writer',
  async open(inbound: Readonly<ByteInbound>) {
    return Promise.resolve({
      bufferedBytes: 0,
      // oxlint-disable-next-line typescript/promise-function-async -- Performance: an async write would allocate a promise per packet inside the measured loop, so this writer returns one settled promise.
      write(bytes: Readonly<Uint8Array<Readonly<ArrayBufferLike>>>) {
        const header = bytes[0];
        if (header === 0x10) inbound.bytes(Uint8Array.of(0x20, 3, 0, 0, 0));
        else if (header === 0x32 || header === 0x34) {
          publications++;
          inbound.bytes(
            Uint8Array.of(header === 0x32 ? 0x40 : 0x50, 2, bytes[identifierOffset] ?? 0, bytes[identifierOffset + 1] ?? 0),
          );
        } else if (header === 0x62) {
          releases++;
          inbound.bytes(Uint8Array.of(0x70, 2, bytes[2] ?? 0, bytes[3] ?? 0));
        } else if (header !== 0xe0) throw new Error('Unexpected packet');
        return completed;
      },
      close: async () => {
        await completed;
      },
    });
  },
};

const client = await createTransportClient(transport, {
  clientId: 'packed-qos-bench',
  ...(withState ? { cleanStart: false, sessionExpiryInterval: 60, sessionState: createSessionState() } : {}),
}).connect();
let profiler: Session | undefined;
try {
  for (let index = 0; index < warmup; index++) await client.publish(topic, payload, { qos });
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
    await client.publish(topic, payload, { qos });
    if (heapProfile === undefined) samples.push(performance.now() - started);
  }
  const elapsed = performance.now() - start;
  assert.equal(publications, warmup + iterations);
  assert.equal(releases, qos === 2 ? warmup + iterations : 0);
  const observation = { node: process.version, v8: process.versions.v8, qos, withState, warmup, iterations };
  if (heapProfile !== undefined && profiler !== undefined) {
    const { profile } = await profiler.post('HeapProfiler.stopSampling');
    writeFileSync(heapProfile, JSON.stringify(profile));
    assert.ok('samples' in profile && Array.isArray(profile.samples));
    const sizes: readonly unknown[] = profile.samples;
    const sampledBytes = sizes.reduce((total: number, sample) => {
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
      }),
    );
  }
} finally {
  profiler?.disconnect();
  await client.disconnect();
}
