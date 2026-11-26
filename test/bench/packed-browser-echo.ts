import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'vite';

type EchoResult = Awaited<ReturnType<typeof import('./browser-broker-workload.js').measureEcho>>;

const [, , baseline, candidate] = process.argv;
assert.ok(
  baseline !== undefined &&
    baseline !== '' &&
    candidate !== undefined &&
    candidate !== '' &&
    resolve(baseline) !== resolve(candidate),
  'Supply two distinct packed consumer directories',
);
const packageRoots = [baseline, candidate].map((consumer) => {
  const installed = resolve(consumer, 'node_modules/mqtt');
  assert.ok(existsSync(resolve(installed, 'package.json')), 'Install mqtt into each consumer directory independently');
  return realpathSync(installed);
});
assert.notEqual(packageRoots[0], packageRoots[1], 'Use independent npm installs');
const url = process.env['MQTT_TEST_WS_URL'];
assert.ok(url !== undefined && url !== '', 'Set MQTT_TEST_WS_URL to the Mosquitto WebSocket listener');
const iterations = Number(process.env['MQTT_TEST_ITERATIONS'] ?? 10_000);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0, 'MQTT_TEST_ITERATIONS must be a positive integer');
const profileDir = process.env['MQTT_BROWSER_PROFILE_DIR'];
const warmup = 1000;

async function bundle(consumer: string) {
  const work = mkdtempSync(resolve(consumer, '.mqtt-browser-bench-'));
  try {
    mkdirSync(resolve(work, 'bench'));
    mkdirSync(resolve(work, 'experiments'));
    const entry = resolve(work, 'bench/browser-broker-workload.ts');
    cpSync(new URL('./browser-broker-workload.ts', import.meta.url), entry);
    cpSync(new URL('../experiments/latencies.ts', import.meta.url), resolve(work, 'experiments/latencies.ts'));
    const result = await build({
      root: work,
      configFile: false,
      logLevel: 'silent',
      build: { write: false, minify: false, lib: { entry, formats: ['es'] } },
    });
    const [output] = Array.isArray(result) ? result : [result];
    assert.ok('output' in output && output.output.length === 1);
    const [chunk] = output.output;
    assert.deepEqual([...chunk.imports, ...chunk.dynamicImports], []);
    assert.doesNotMatch(chunk.code, /__vite-browser-external|\bBuffer\b|\bnode:/u);
    return chunk.code;
  } finally {
    rmSync(work, { recursive: true });
  }
}

const bundles = { baseline: await bundle(baseline), candidate: await bundle(candidate) };

async function run(variant: keyof typeof bundles, pair: number, profile?: 'cpu' | 'heap') {
  assert.ok(url !== undefined);
  const code = bundles[variant];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Serve the bundle from a page with a precise performance clock.
  const server = createServer((request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (request.url === '/broker-echo.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>');
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto('http://127.0.0.1:' + address.port);
      assert.equal(await page.evaluate(() => crossOriginIsolated), true);
      const cdp = await page.context().newCDPSession(page);
      const { product, jsVersion } = await cdp.send('Browser.getVersion');
      const metadata = { variant, pair, product, v8: jsVersion, profile };
      if (profile === 'cpu') {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
      } else if (profile === 'heap') {
        await cdp.send('HeapProfiler.startSampling', {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      if (!profile) {
        const connections = await page.evaluate(async (url) => (await import('/broker-echo.js')).measureConnections(url, 25), url);
        assert.equal(connections.connectMs.count, 25);
        assert.equal(connections.disconnectMs.count, 25);
        console.log(JSON.stringify({ ...metadata, ...connections }));
      }
      for (const qos of [0, 1] as const) {
        const echo: EchoResult = await page.evaluate(
          async (options: Readonly<{ url: string; qos: 0 | 1; warmup: number; iterations: number }>) =>
            (await import('/broker-echo.js')).measureEcho(options),
          { url, qos, warmup, iterations },
        );
        assert.equal(echo.echoCount, warmup + iterations);
        assert.equal(echo.echoMs.count, iterations);
        console.log(JSON.stringify({ ...metadata, ...echo }));
      }
      if (profile) {
        assert.ok(profileDir !== undefined && profileDir !== '');
        const output = await (profile === 'cpu' ? cdp.send('Profiler.stop') : cdp.send('HeapProfiler.stopSampling'));
        writeFileSync(
          resolve(profileDir, profile === 'cpu' ? 'browser.cpuprofile' : 'browser.heapprofile'),
          JSON.stringify(output.profile),
        );
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }
}

if (profileDir !== undefined && profileDir !== '') {
  mkdirSync(profileDir, { recursive: true });
  await run('candidate', 0, 'cpu');
  await run('candidate', 0, 'heap');
} else {
  for (let pair = 1; pair <= 5; pair++) {
    const order = pair % 2 === 1 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const);
    for (const variant of order) await run(variant, pair);
  }
}
