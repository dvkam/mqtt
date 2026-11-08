import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { availableParallelism, cpus, release } from 'node:os';
import { generate, parser } from 'mqtt-packet';
import { StreamingNodeDecoder } from '../experiments/streaming-node-decoder.ts';
import { NodePacketDecoder } from '../../src/nodePacketDecoder.ts';

type Strategy = 'reference' | 'compact' | 'streaming';
const strategies: readonly Strategy[] = ['reference', 'compact', 'streaming'];
const iterations = 5000;
const warmup = 1000;
console.log(
  JSON.stringify({
    kind: 'environment',
    runtime: process.version,
    platform: process.platform,
    architecture: process.arch,
    kernel: release(),
    parallelism: availableParallelism(),
    cpu: cpus()[0]?.model,
  }),
);
const wire = generate(
  { cmd: 'publish', topic: 'a', payload: Buffer.alloc(256, 97), qos: 0, dup: false, retain: false },
  { protocolVersion: 5 },
);

function createDecoder(strategy: Strategy, onPacket: (packet: unknown) => void) {
  if (strategy === 'compact') return new NodePacketDecoder({ maxPacketBytes: wire.length, onPacket });
  if (strategy === 'streaming') return new StreamingNodeDecoder({ maxPacketBytes: wire.length, onPacket });
  const decoder = parser({ protocolVersion: 5 });
  decoder.on('packet', onPacket);
  decoder.on('error', (reason: unknown) => {
    throw reason instanceof Error ? reason : new Error('Unexpected reference failure');
  });
  return {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The reference parser consumes native mutable byte views.
    push(bytes: Readonly<Uint8Array>) {
      decoder.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
  };
}

for (let repetition = 0; repetition < 3; repetition++) {
  for (const fragmentBytes of [wire.length, 1]) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < wire.length; offset += fragmentBytes) chunks.push(wire.subarray(offset, offset + fragmentBytes));
    for (const strategy of strategies) {
      let packets = 0;
      let checksum = 0;
      const decoder = createDecoder(strategy, (packet: unknown) => {
        if (typeof packet !== 'object' || packet === null || !('payload' in packet) || !Buffer.isBuffer(packet.payload)) {
          throw new Error('Expected Buffer publication');
        }
        packets++;
        checksum += packet.payload.length;
      });
      const operation = () => {
        for (const chunk of chunks) decoder.push(chunk);
      };
      for (let index = 0; index < warmup; index++) operation();
      globalThis.gc?.();
      const session = new Session();
      session.connect();
      try {
        await session.post('HeapProfiler.startSampling', {
          samplingInterval: 1024,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        const start = performance.now();
        for (let index = 0; index < iterations; index++) operation();
        const elapsedMs = performance.now() - start;
        const { profile } = await session.post('HeapProfiler.stopSampling');
        assert.equal(packets, iterations + warmup);
        assert.equal(checksum, (iterations + warmup) * 256);
        console.log(
          JSON.stringify({
            kind: 'throughput',
            strategy,
            repetition,
            runtime: process.version,
            fragmentBytes,
            iterations,
            warmup,
            wireBytes: wire.length,
            elapsedMs,
            packetsPerSecond: (iterations * 1000) / elapsedMs,
            sampledHeapBytes: sampledBytes(profile),
            checksum,
          }),
        );
      } finally {
        session.disconnect();
      }
    }
  }
}

for (const strategy of strategies) {
  let payload: Buffer | undefined;
  const decoder = createDecoder(strategy, (packet: unknown) => {
    if (typeof packet === 'object' && packet !== null && 'payload' in packet && Buffer.isBuffer(packet.payload))
      payload = packet.payload;
  });
  const input = Buffer.allocUnsafeSlow(wire.length + 2 * 10000);
  input.set(wire);
  for (let offset = wire.length; offset < input.length; offset += 2) input.set([0xd0, 0], offset);
  decoder.push(input);
  assert.ok(payload !== undefined);
  console.log(
    JSON.stringify({
      kind: 'retained-backing',
      strategy,
      payloadBytes: payload.length,
      backingBytes: payload.buffer.byteLength,
      inputBytes: input.length,
    }),
  );
}

function sampledBytes(profile: unknown): number {
  if (typeof profile !== 'object' || profile === null || !('samples' in profile) || !Array.isArray(profile.samples)) {
    throw new Error('Expected heap allocation samples');
  }
  const samples: unknown[] = profile.samples;
  let total = 0;
  for (const sample of samples) {
    if (typeof sample !== 'object' || sample === null || !('size' in sample) || typeof sample.size !== 'number') {
      throw new Error('Invalid heap allocation sample');
    }
    total += sample.size;
  }
  return total;
}
