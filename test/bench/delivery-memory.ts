import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { setImmediate } from 'node:timers/promises';
import { compareDelivery, type DeliveryMode } from '../experiments/delivery-comparison.ts';

const [mode, measurement] = process.argv.slice(2);
if (mode !== 'callback' && mode !== 'iterator' && mode !== 'web-stream') throw new Error('Choose callback, iterator or web-stream');
if (measurement !== 'allocations' && measurement !== 'retained') throw new Error('Choose allocations or retained');

const count = 20_000;
const payloadBytes = 256;
const passes = 5;
const samplingInterval = 1024;

await checkedDelivery(mode);
if (measurement === 'allocations') {
  const inspector = new Session();
  inspector.connect();
  try {
    await inspector.post('HeapProfiler.startSampling', {
      samplingInterval,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await checkedDelivery(mode);
    const { profile } = await inspector.post('HeapProfiler.stopSampling');
    const sampledAllocationBytes = sampledBytes(profile);
    console.log(
      JSON.stringify({
        mode,
        measurement,
        runtime: process.version,
        count,
        payloadBytes,
        samplingInterval,
        sampledAllocationBytes,
      }),
    );
  } finally {
    inspector.disconnect();
  }
} else {
  const collect = globalThis.gc;
  if (collect === undefined) throw new Error('Run retained measurements with node --expose-gc');
  await setImmediate();
  collect();
  const before = process.memoryUsage();
  for (let pass = 0; pass < passes; pass++) await checkedDelivery(mode);
  await setImmediate();
  collect();
  const after = process.memoryUsage();
  console.log(
    JSON.stringify({
      mode,
      measurement,
      runtime: process.version,
      count,
      payloadBytes,
      passes,
      heapUsedDelta: after.heapUsed - before.heapUsed,
      arrayBufferDelta: after.arrayBuffers - before.arrayBuffers,
    }),
  );
}

async function checkedDelivery(mode: DeliveryMode) {
  const result = await compareDelivery(mode, count, payloadBytes);
  assert.equal(result.attempted, count);
  assert.equal(result.received, count);
  assert.equal(result.ordered, true);
  assert.equal(result.checksum, (count * (count - 1)) / 2);
  assert.ok(result.peakMessages <= 16 && result.peakBytes <= 16 * (payloadBytes + 2));
}

function sampledBytes(profile: unknown): number {
  assert.ok(typeof profile === 'object' && profile !== null && 'samples' in profile && Array.isArray(profile.samples));
  const samples: readonly unknown[] = profile.samples;
  return samples.reduce((total: number, sample) => {
    assert.ok(typeof sample === 'object' && sample !== null && 'size' in sample && typeof sample.size === 'number');
    return total + sample.size;
  }, 0);
}
