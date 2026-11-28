// Measures what `promise-function-async` and `require-await` ask of a function that runs once for each message.
// Run: node --expose-gc --max-semi-space-size=256 test/bench/promise-forwarding.ts
import assert from 'node:assert/strict';

const settled = Promise.resolve();
let calls = 0;

// oxlint-disable-next-line typescript/promise-function-async -- Removing it would cost developer experience. This function is the baseline the benchmark measures, a call that returns the promise it was given, and an async function cannot express that.
function forward(): Promise<void> {
  calls++;
  return settled;
}

async function asyncForward(): Promise<void> {
  calls++;
  return settled;
}

// oxlint-disable-next-line typescript/require-await -- Removing it would cost developer experience. This function is the second baseline the benchmark measures, an async function with nothing to wait for, and returning a promise from it would turn it into asyncForward.
async function asyncBare(): Promise<void> {
  calls++;
}

const variants = [
  ['returns the given promise, no async', forward],
  ['async, returns the given promise', asyncForward],
  ['async, nothing awaited', asyncBare],
] as const;

async function awaited(call: () => Promise<void>, count: number): Promise<void> {
  for (let index = 0; index < count; index++) await call();
}

/** 64 calls in one turn and one await, as a publish burst does. */
async function burst(call: () => Promise<void>, count: number): Promise<void> {
  for (let index = 0; index < count; index += 64) {
    let last = settled;
    for (let inner = 0; inner < 64; inner++) last = call();
    await last;
  }
}

async function median(run: () => Promise<void>, count: number): Promise<number> {
  const samples: number[] = [];
  for (let round = 0; round < 5; round++) {
    const start = process.hrtime.bigint();
    await run();
    samples.push(Number(process.hrtime.bigint() - start) / count);
  }
  return samples.toSorted((left, right) => left - right)[2] ?? Number.NaN;
}

const iterations = Number(process.env['MQTT_TEST_ITERATIONS'] ?? 4_000_000);
const allocationCalls = 100_000;
assert.ok(typeof globalThis.gc === 'function', 'Run with --expose-gc and --max-semi-space-size=256');
const results: { variant: string; awaitedNs: number; burstNs: number; bytesPerCall: number }[] = [];
for (const [variant, call] of variants) {
  await awaited(call, 200_000);
  await burst(call, 200_000);
  const awaitedNs = await median(async () => awaited(call, iterations), iterations);
  const burstNs = await median(async () => burst(call, iterations), iterations);
  // The young generation is large enough that no scavenge runs between the two readings.
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  let last = settled;
  for (let index = 0; index < allocationCalls; index++) last = call();
  const bytesPerCall = (process.memoryUsage().heapUsed - before) / allocationCalls;
  await last;
  results.push({ variant, awaitedNs, burstNs, bytesPerCall });
}
assert.ok(calls > 0);
process.stdout.write(JSON.stringify({ node: process.version, iterations, results }) + '\n');
