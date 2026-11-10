import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { fileURLToPath } from 'node:url';
import type { DeliveryMode } from '../experiments/delivery-comparison.ts';
import {
  assertFixedRateDelivery,
  fixedRatePlans,
  runFixedRateDelivery,
  type FixedRatePlan,
} from '../experiments/fixed-rate-delivery.ts';

declare const BrowserFixedRate: typeof import('../experiments/fixed-rate-delivery.ts');

const [runtime, workload, mode] = process.argv.slice(2);
if (runtime !== 'node' && runtime !== 'chromium') throw new Error('Choose node or chromium');
if (workload !== 'shallow' && workload !== 'deep') throw new Error('Choose shallow or deep');
if (mode !== 'callback' && mode !== 'iterator' && mode !== 'web-stream') throw new Error('Choose callback, iterator or web-stream');

const plan = fixedRatePlans[workload];
const sampling = {
  samplingInterval: 1024,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
};
const observation = runtime === 'node' ? await profileNode(mode, plan) : await profileChromium(mode, plan);
console.log(JSON.stringify({ runtime, workload, mode, plan, sampling, ...observation }));

async function profileNode(mode: DeliveryMode, plan: FixedRatePlan) {
  assertFixedRateDelivery(await runFixedRateDelivery(mode, plan), plan);
  const unprofiled = await runFixedRateDelivery(mode, plan);
  assertFixedRateDelivery(unprofiled, plan);
  const session = new Session();
  session.connect();
  try {
    await session.post('HeapProfiler.startSampling', sampling);
    const delivery = await runFixedRateDelivery(mode, plan);
    const { profile } = await session.post('HeapProfiler.stopSampling');
    assertFixedRateDelivery(delivery, plan);
    return { version: process.version, unprofiled, delivery, ...summarizeProfile(profile) };
  } finally {
    session.disconnect();
  }
}

async function profileChromium(mode: DeliveryMode, plan: FixedRatePlan) {
  const [{ chromium }, { build }] = await Promise.all([import('playwright'), import('vite')]);
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('../experiments/fixed-rate-delivery.ts', import.meta.url)),
        name: 'BrowserFixedRate',
        formats: ['iife'],
      },
    },
  });
  const bundle = Array.isArray(built) ? built[0] : built;
  assert.ok(bundle && 'output' in bundle && bundle.output.length === 1);
  const [chunk] = bundle.output;
  assert.ok(chunk.imports.length === 0);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: chunk.code + '\n//# sourceURL=mqtt-fixed-rate-delivery.js' });
    const protocol = await page.context().newCDPSession(page);
    const run = async () =>
      page.evaluate(
        async ({ mode, plan }: Readonly<{ mode: DeliveryMode; plan: FixedRatePlan }>) =>
          BrowserFixedRate.runFixedRateDelivery(mode, plan),
        { mode, plan },
      );
    assertFixedRateDelivery(await run(), plan);
    const unprofiled = await run();
    assertFixedRateDelivery(unprofiled, plan);
    await protocol.send('HeapProfiler.startSampling', sampling);
    const delivery = await run();
    const { profile } = await protocol.send('HeapProfiler.stopSampling');
    assertFixedRateDelivery(delivery, plan);
    return { version: browser.version(), unprofiled, delivery, ...summarizeProfile(profile) };
  } finally {
    await browser.close();
  }
}

function summarizeProfile(profile: unknown) {
  assert.ok(
    typeof profile === 'object' && profile !== null && 'head' in profile && 'samples' in profile && Array.isArray(profile.samples),
  );
  const samples: readonly unknown[] = profile.samples;
  const sampledAllocationBytes = samples.reduce((total: number, sample) => {
    assert.ok(typeof sample === 'object' && sample !== null && 'size' in sample && typeof sample.size === 'number');
    return total + sample.size;
  }, 0);
  assert.ok(Number.isSafeInteger(sampledAllocationBytes) && sampledAllocationBytes > 0);
  const stacks: { bytes: number; sites: readonly string[] }[] = [];
  function visit(node: unknown, ancestors: readonly string[]) {
    assert.ok(
      typeof node === 'object' &&
        node !== null &&
        'callFrame' in node &&
        'selfSize' in node &&
        typeof node.selfSize === 'number' &&
        'children' in node &&
        Array.isArray(node.children),
    );
    const frame = node.callFrame;
    assert.ok(
      typeof frame === 'object' &&
        frame !== null &&
        'functionName' in frame &&
        typeof frame.functionName === 'string' &&
        'url' in frame &&
        typeof frame.url === 'string' &&
        'lineNumber' in frame &&
        typeof frame.lineNumber === 'number',
    );
    const site =
      (frame.functionName || '(anonymous)') +
      '@' +
      (frame.url.slice(frame.url.lastIndexOf('/') + 1) || '(runtime)') +
      ':' +
      (frame.lineNumber + 1);
    const sites = [...ancestors, site];
    if (node.selfSize > 0) stacks.push({ bytes: node.selfSize, sites: sites.slice(-5) });
    const children: readonly unknown[] = node.children;
    for (const child of children) visit(child, sites);
  }
  visit(profile.head, []);
  stacks.sort((left: Readonly<{ bytes: number }>, right: Readonly<{ bytes: number }>) => right.bytes - left.bytes);
  return { sampledAllocationBytes, topStacks: stacks.slice(0, 12) };
}
