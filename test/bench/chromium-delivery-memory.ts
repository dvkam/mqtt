import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, type CDPSession, type Page } from 'playwright';
import { build } from 'vite';
import type { DeliveryMode } from '../experiments/delivery-comparison.ts';

declare const BrowserDelivery: typeof import('../experiments/delivery-comparison.ts');
type StalledDelivery = Readonly<ReturnType<typeof BrowserDelivery.createStalledDelivery>>;

const count = 20_000;
const payloadBytes = 256;
const samplingInterval = 1024;
const queueCount = 64;
const modes = ['callback', 'iterator', 'web-stream'] as const;
const buildResult = await build({
  configFile: false,
  logLevel: 'silent',
  build: {
    write: false,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('../experiments/delivery-comparison.ts', import.meta.url)),
      name: 'BrowserDelivery',
      formats: ['iife'],
    },
  },
});
const bundle = Array.isArray(buildResult) ? buildResult[0] : buildResult;
assert.ok(bundle && 'output' in bundle && bundle.output.length === 1);
const [chunk] = bundle.output;
assert.ok(chunk.imports.length === 0);

for (let repeat = 0; repeat < 5; repeat++) {
  for (const mode of [...modes.slice(repeat % modes.length), ...modes.slice(0, repeat % modes.length)]) {
    await run(mode, repeat, 'allocations');
    if (mode !== 'callback') await run(mode, repeat, 'stalled');
  }
}

async function run(mode: DeliveryMode, repeat: number, measurement: 'allocations' | 'stalled') {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: chunk.code });
    const protocol = await page.context().newCDPSession(page);
    const base = { mode, repeat, measurement, chromium: browser.version() };
    if (measurement === 'allocations') {
      await checkedDelivery(page, mode);
      await protocol.send('HeapProfiler.startSampling', {
        samplingInterval,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await checkedDelivery(page, mode);
      const { profile } = await protocol.send('HeapProfiler.stopSampling');
      const sampledAllocationBytes = profile.samples.reduce((total, { size }: Readonly<{ size: number }>) => total + size, 0);
      assert.ok(Number.isSafeInteger(sampledAllocationBytes) && sampledAllocationBytes > 0);
      console.log(JSON.stringify({ ...base, count, payloadBytes, samplingInterval, sampledAllocationBytes }));
    } else {
      assert.ok(mode !== 'callback');
      const workload = await page.evaluateHandle(
        ({ mode, queueCount }: Readonly<{ mode: Exclude<DeliveryMode, 'callback'>; queueCount: number }>): StalledDelivery =>
          BrowserDelivery.createStalledDelivery(mode, queueCount),
        { mode, queueCount },
      );
      const empty = { messages: 0, bytes: 0 };
      assert.deepEqual(await workload.evaluate((workload) => workload.snapshot()), empty);
      const before = await heapUsage(protocol);
      await workload.evaluate((workload) => {
        workload.fill();
      });
      const occupancy = await workload.evaluate((workload) => workload.snapshot());
      assert.deepEqual(occupancy, { messages: queueCount * 16, bytes: queueCount * 16 * (4096 + 2) });
      const held = await heapUsage(protocol);
      await workload.evaluate(async (workload) => workload.cancel());
      assert.deepEqual(await workload.evaluate((workload) => workload.snapshot()), empty);
      const cancelled = await heapUsage(protocol);
      await workload.dispose();
      console.log(JSON.stringify({ ...base, queueCount, occupancy, before, held, cancelled }));
    }
  } finally {
    await browser.close();
  }
}

async function checkedDelivery(page: Readonly<Pick<Page, 'evaluate'>>, mode: DeliveryMode) {
  const delivery = await page.evaluate(
    async ({ mode, count, payloadBytes }: Readonly<{ mode: DeliveryMode; count: number; payloadBytes: number }>) =>
      BrowserDelivery.compareDelivery(mode, count, payloadBytes),
    { mode, count, payloadBytes },
  );
  assert.equal(delivery.attempted, count);
  assert.equal(delivery.received, count);
  assert.equal(delivery.ordered, true);
  assert.equal(delivery.checksum, (count * (count - 1)) / 2);
  assert.ok(delivery.peakMessages <= 16 && delivery.peakBytes <= 16 * (payloadBytes + 2));
}

async function heapUsage(protocol: Readonly<Pick<CDPSession, 'send'>>) {
  await protocol.send('HeapProfiler.collectGarbage');
  const { usedSize, backingStorageSize } = await protocol.send('Runtime.getHeapUsage');
  assert.ok(Number.isSafeInteger(usedSize) && Number.isSafeInteger(backingStorageSize));
  return { usedSize, backingStorageSize };
}
