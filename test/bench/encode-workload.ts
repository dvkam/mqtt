import type { UserProperty } from '../../src/codec.ts';

type EncodingWorkload = Readonly<{ name: string; size: number; topic: string; properties?: readonly UserProperty[] }>;

export const workloads: readonly EncodingWorkload[] = [
  ...[0, 16, 256, 4096, 65536].map((size) => ({ name: 'ascii-' + size, size, topic: 'bench/topic' })),
  { name: 'unicode-256', size: 256, topic: 'bench/é/😀/\ufeff' },
  {
    name: 'properties-256',
    size: 256,
    topic: 'bench/é',
    properties: [
      ['k', ''],
      ['x', 'π'.repeat(64)],
      ['k', '😀'],
    ],
  },
];

export function makePacket(workload: EncodingWorkload) {
  return {
    cmd: 'publish' as const,
    topic: workload.topic,
    payload: new Uint8Array(workload.size).fill(97),
    ...(workload.properties ? { userProperties: workload.properties } : {}),
  };
}

export function timed(encode: () => number, iterations: number) {
  let checksum = 0;
  const start = performance.now();
  for (let index = 0; index < iterations; index++) checksum += encode();
  return { iterations, ms: performance.now() - start, checksum };
}

export function iterationsFor(size: number): number {
  return Math.max(2000, Math.min(100_000, Math.floor(67_108_864 / Math.max(256, size))));
}
