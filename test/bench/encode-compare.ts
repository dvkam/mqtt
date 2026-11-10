import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { generate, type IPublishPacket } from 'mqtt-packet';
import { chromium } from 'playwright';
import { build } from 'vite';
import { encodePacket } from '../../dist/codec.js';
import { iterationsFor, makePacket, timed, workloads } from './encode-workload.ts';

type BrowserWorkload = Readonly<{ name: string; index: number; iterations: number; frameBytes: number }>;

function summarize(profile: unknown) {
  if (
    typeof profile !== 'object' ||
    profile === null ||
    !('head' in profile) ||
    !('samples' in profile) ||
    !Array.isArray(profile.samples)
  )
    throw new Error('Missing allocation profile');
  const samples: readonly unknown[] = profile.samples;
  const paths = new Map<number, string>();
  const bytesByStack = new Map<string, number>();
  function indexStack(node: unknown, parents: readonly string[]) {
    if (typeof node !== 'object' || node === null || !('id' in node) || typeof node.id !== 'number' || !('callFrame' in node))
      throw new Error('Invalid allocation stack');
    const frame = node.callFrame;
    if (typeof frame !== 'object' || frame === null || !('functionName' in frame) || typeof frame.functionName !== 'string')
      throw new Error('Invalid allocation frame');
    const stack = frame.functionName ? [...parents, frame.functionName] : parents;
    paths.set(node.id, stack.slice(-6).join(' > '));
    if ('children' in node && Array.isArray(node.children)) {
      const children: readonly unknown[] = node.children;
      for (const child of children) indexStack(child, stack);
    }
  }
  indexStack(profile.head, []);
  let bytes = 0;
  for (const sample of samples) {
    if (
      typeof sample !== 'object' ||
      sample === null ||
      !('nodeId' in sample) ||
      typeof sample.nodeId !== 'number' ||
      !('size' in sample) ||
      typeof sample.size !== 'number'
    )
      throw new Error('Invalid allocation sample');
    const stack = paths.get(sample.nodeId) ?? '(anonymous)';
    bytes += sample.size;
    bytesByStack.set(stack, (bytesByStack.get(stack) ?? 0) + sample.size);
  }
  const stacks = [...bytesByStack]
    .sort((left: readonly [string, number], right: readonly [string, number]) => right[1] - left[1])
    .slice(0, 8);
  return { bytes, stacks };
}

async function sampled(encode: () => number, iterations: number) {
  const session = new Session();
  session.connect();
  try {
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const run = timed(encode, iterations);
    const { profile } = await session.post('HeapProfiler.stopSampling');
    return { ...run, ...summarize(profile) };
  } finally {
    session.disconnect();
  }
}

function isCodec(value: unknown): value is Readonly<{ encodePacket: typeof encodePacket }> {
  return typeof value === 'object' && value !== null && 'encodePacket' in value && typeof value.encodePacket === 'function';
}

async function bundle(entry: string, minify: boolean) {
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    build: { write: false, minify, lib: { entry, formats: ['es'] } },
  });
  const result = Array.isArray(built) ? built[0] : built;
  assert.ok(result && 'output' in result);
  const [chunk] = result.output;
  assert.ok(result.output.length === 1 && chunk.imports.length === 0);
  return chunk.code;
}

async function measureBrowser(beforePath: string, matrix: readonly BrowserWorkload[]) {
  const directory = mkdtempSync(join(tmpdir(), 'mqtt-encode-bench-'));
  const workloadPath = fileURLToPath(new URL('./encode-workload.ts', import.meta.url));
  const currentPath = fileURLToPath(new URL('../../dist/codec.js', import.meta.url));
  const urls = [];
  try {
    for (const [engine, entry] of [
      ['before', beforePath],
      ['after', currentPath],
    ] as const) {
      const packed = await bundle(entry, true);
      console.log(JSON.stringify({ kind: 'bundle', engine, bytes: Buffer.byteLength(packed), gzip: gzipSync(packed).length }));
      const fixture = join(directory, engine + '.mjs');
      writeFileSync(
        fixture,
        `import { encodePacket } from ${JSON.stringify(entry)};
import { workloads, makePacket, timed } from ${JSON.stringify(workloadPath)};
export const run = (index, iterations) => {
  const packet = makePacket(workloads[index]);
  return timed(() => encodePacket(packet).length, iterations);
};`,
      );
      const code = await bundle(fixture, false);
      urls.push('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    }
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      console.log(JSON.stringify({ kind: 'browser', version: browser.version() }));
      const results = await page.evaluate(
        async ({ urls, matrix }: Readonly<{ urls: readonly string[]; matrix: readonly BrowserWorkload[] }>) => {
          const runners = await Promise.all(
            urls.map(async (url) => {
              const entry: unknown = await import(url);
              if (typeof entry !== 'object' || entry === null || !('run' in entry) || typeof entry.run !== 'function')
                throw new Error('Expected browser measurement runner');
              const run = entry.run;
              return (index: number, iterations: number): unknown => Reflect.apply(run, undefined, [index, iterations]);
            }),
          );
          const rows = [];
          for (const { name, index, iterations, frameBytes } of matrix) {
            for (const run of runners) run(index, 2000);
            for (let repeat = 0; repeat < 3; repeat++) {
              const order = repeat % 2 ? [1, 0] : [0, 1];
              for (const engineIndex of order) {
                const result = runners[engineIndex]?.(index, iterations);
                if (
                  typeof result !== 'object' ||
                  result === null ||
                  !('checksum' in result) ||
                  !('ms' in result) ||
                  result.checksum !== iterations * frameBytes ||
                  typeof result.ms !== 'number'
                )
                  throw new Error('Invalid browser sample');
                rows.push({
                  kind: 'timing',
                  workload: name,
                  repeat,
                  engine: engineIndex === 0 ? 'before' : 'after',
                  iterations,
                  checksum: result.checksum,
                  ms: result.ms,
                });
              }
            }
          }
          return rows;
        },
        { urls, matrix },
      );
      for (const row of results) console.log(JSON.stringify(row));
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const baselinePath = process.argv[2];
assert.ok(baselinePath !== undefined && baselinePath !== '', 'Pass the baseline compiled codec.js path');
const beforePath = resolve(baselinePath);
const baseline: unknown = await import(pathToFileURL(beforePath).href);
assert.ok(isCodec(baseline), 'Expected baseline encodePacket export');
const before = baseline.encodePacket;
const matrix: BrowserWorkload[] = [];
const browserOnly = process.argv.includes('--browser');
console.log(
  JSON.stringify({ platform: platform(), arch: arch(), runtime: process.version, cpu: cpus()[0]?.model, v8: process.versions.v8 }),
);
for (const [index, workload] of workloads.entries()) {
  const packet = makePacket(workload);
  const expected = Buffer.from(before(packet));
  assert.deepEqual(Buffer.from(encodePacket(packet)), expected);
  matrix.push({ name: workload.name, index, iterations: iterationsFor(workload.size), frameBytes: expected.length });
  if (browserOnly) continue;

  const encoders = [
    { engine: 'before', encode: () => before(packet).length },
    { engine: 'after', encode: () => encodePacket(packet).length },
  ];
  if (!workload.properties) {
    const source: IPublishPacket = {
      cmd: 'publish',
      topic: packet.topic,
      payload: Buffer.from(packet.payload),
      qos: 0,
      dup: false,
      retain: false,
    };
    assert.deepEqual(generate(source, { protocolVersion: 5 }), expected);
    encoders.push({ engine: 'mqtt-packet', encode: () => generate(source, { protocolVersion: 5 }).length });
  }
  for (const { encode } of encoders) timed(encode, 2000);
  for (let repeat = 0; repeat < 3; repeat++) {
    const order = repeat % 2 ? [...encoders].reverse() : encoders;
    for (const { engine, encode } of order) {
      const result = timed(encode, iterationsFor(workload.size));
      assert.equal(result.checksum, result.iterations * expected.length);
      console.log(JSON.stringify({ kind: 'timing', workload: workload.name, repeat, engine, ...result }));
    }
  }
  if (['ascii-256', 'ascii-65536', 'properties-256'].includes(workload.name)) {
    for (let repeat = 0; repeat < 3; repeat++) {
      const order = repeat % 2 ? [...encoders].reverse() : encoders;
      for (const { engine, encode } of order) {
        const result = await sampled(encode, workload.size < 4096 ? 10000 : 2000);
        assert.equal(result.checksum, result.iterations * expected.length);
        console.log(JSON.stringify({ kind: 'profile', workload: workload.name, repeat, engine, ...result }));
      }
    }
  }
}
if (browserOnly) await measureBrowser(beforePath, matrix);
