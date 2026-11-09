import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { generate, parser, type IPublishPacket } from 'mqtt-packet';
import { encodePacket, PacketDecoder, type WirePacket } from '../../dist/codec.js';

const iterations = 10_000;
const payload = new Uint8Array(256).fill(97);
const packet: Extract<WirePacket, { cmd: 'publish' }> = { cmd: 'publish', topic: 'bench/topic', payload };
const upstreamPacket: IPublishPacket = { ...packet, payload: Buffer.from(payload), qos: 0, dup: false, retain: false };
const bytes = encodePacket(packet);
assert.deepEqual(Buffer.from(bytes), generate(upstreamPacket, { protocolVersion: 5 }));
const nativeDecoder = new PacketDecoder();
const upstreamDecoder = parser({ protocolVersion: 5 });
let decodedBytes = 0;
upstreamDecoder.on('packet', (decoded: Readonly<{ cmd: string; payload?: Readonly<{ length: number }> }>) => {
  if (decoded.cmd !== 'publish' || decoded.payload === undefined) throw new Error('Expected PUBLISH');
  decodedBytes = decoded.payload.length;
});
const upstreamBytes = Buffer.from(bytes);

async function measure(name: string, operation: () => number) {
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

function sampledBytes(profile: unknown): number {
  if (typeof profile !== 'object' || profile === null || !('samples' in profile) || !Array.isArray(profile.samples))
    throw new Error('Inspector did not return allocation samples');
  const samples: readonly unknown[] = profile.samples;
  return samples.reduce((sum: number, sample) => {
    if (typeof sample !== 'object' || sample === null || !('size' in sample) || typeof sample.size !== 'number')
      throw new Error('Invalid allocation sample');
    return sum + sample.size;
  }, 0);
}
