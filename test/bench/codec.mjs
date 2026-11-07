import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { generate, parser } from 'mqtt-packet';
import { encodePacket, PacketDecoder } from '../../dist/codec.js';

const iterations = 10_000;
const payload = new Uint8Array(256).fill(97);
/** @type {Extract<import('../../dist/codec.js').WirePacket, {cmd: 'publish'}>} */
const packet = { cmd: 'publish', topic: 'bench/topic', payload };
/** @type {import('mqtt-packet').IPublishPacket} */
const upstreamPacket = { ...packet, payload: Buffer.from(payload), qos: 0, dup: false, retain: false };
const bytes = encodePacket(packet);
assert.deepEqual(Buffer.from(bytes), generate(upstreamPacket, { protocolVersion: 5 }));
const nativeDecoder = new PacketDecoder();
const upstreamDecoder = parser({ protocolVersion: 5 });
let decodedBytes = 0;
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
upstreamDecoder.on('packet', (value) => {
  if (value.cmd !== 'publish') throw new Error('Expected PUBLISH');
  decodedBytes = value.payload.length;
});
const upstreamBytes = Buffer.from(bytes);

/** @param {string} name @param {() => number} operation */
async function measure(name, operation) {
  for (let index = 0; index < 1000; index++) operation();
  const session = new Session();
  session.connect();
  try {
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const start = performance.now();
    let checksum = 0;
    for (let index = 0; index < iterations; index++) checksum += operation();
    const elapsedMs = performance.now() - start;
    const { profile } = await session.post('HeapProfiler.stopSampling');
    const sampledAllocationBytes = sampledBytes(profile);
    console.log(
      JSON.stringify({
        name,
        runtime: process.version,
        iterations,
        elapsedMs,
        operationsPerSecond: (iterations * 1000) / elapsedMs,
        sampledAllocationBytes,
        checksum,
      }),
    );
  } finally {
    session.disconnect();
  }
}

await measure('prototype encode', () => encodePacket(packet).length);
await measure('mqtt-packet encode', () => generate(upstreamPacket, { protocolVersion: 5 }).length);
await measure('prototype decode', () => {
  const decoded = nativeDecoder.push(bytes)[0];
  if (decoded?.cmd !== 'publish') throw new Error('Expected PUBLISH');
  return decoded.payload.length;
});
await measure('mqtt-packet decode', () => {
  upstreamDecoder.parse(upstreamBytes);
  return decodedBytes;
});

/** @param {unknown} profile */
function sampledBytes(profile) {
  if (typeof profile !== 'object' || profile === null || !('samples' in profile) || !Array.isArray(profile.samples))
    throw new Error('Inspector did not return allocation samples');
  /** @type {unknown[]} */
  const samples = profile.samples;
  return samples.reduce(
    /** @param {number} sum */ (sum, sample) => {
      if (typeof sample !== 'object' || sample === null || !('size' in sample) || typeof sample.size !== 'number')
        throw new Error('Invalid allocation sample');
      return sum + sample.size;
    },
    0,
  );
}
