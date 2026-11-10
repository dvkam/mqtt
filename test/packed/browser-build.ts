import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { startProtocolPeer } from '../experiments/protocol-peer.ts';
import { checkSsrConsumer } from './ssr-check.ts';
import { startReceivePeer } from '../experiments/receive-peer.ts';

const inputRoot = process.argv[2];
assert.ok(inputRoot !== undefined && inputRoot !== '', 'Expected packed consumer directory');
const root = resolve(inputRoot);
cpSync(new URL('./browser', import.meta.url), resolve(root, 'browser'), { recursive: true });
const floorCompiler = fileURLToPath(new URL('../../node_modules/typescript-stable/bin/tsc', import.meta.url));
const floorVersion = execFileSync(process.execPath, [floorCompiler, '--version'], { encoding: 'utf8' }).trim();
assert.equal(floorVersion, 'Version 7.0.2');
console.log('Checking packed Node and browser declarations with TypeScript 7.0.2');
for (const project of ['tsconfig.json', 'browser/tsconfig.json']) {
  execFileSync(process.execPath, [floorCompiler, '-p', resolve(root, project)], { stdio: 'inherit' });
}
execFileSync(
  process.execPath,
  [fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)), '-p', resolve(root, 'browser/tsconfig.json')],
  { stdio: 'inherit' },
);
await checkSsrConsumer(root);
async function bundleBrowser(entry: string) {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: { write: false, lib: { entry: resolve(root, entry), formats: ['es'] } },
  });
  const chunks = [];
  for (const bundle of Array.isArray(result) ? result : [result]) {
    if (!('output' in bundle)) throw new Error('Unexpected Vite watcher');
    for (const entry of bundle.output) {
      if (entry.type === 'chunk') chunks.push(entry);
    }
  }

  assert.equal(chunks.length, 1);
  const chunk = chunks[0];
  assert.ok(chunk?.type === 'chunk');
  const { code, imports, dynamicImports } = chunk;
  assert.deepEqual([...imports, ...dynamicImports], []);
  assert.doesNotMatch(code, /__vite-browser-external|\bBuffer\b|\bnode:/);
  return code;
}
const code = await bundleBrowser('browser.mjs');
assert.doesNotMatch(code, /Application message queue capacity exceeded/);
console.log(JSON.stringify({ browserBytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length }));
cpSync(new URL('../experiments', import.meta.url), resolve(root, 'experiments'), { recursive: true });
mkdirSync(resolve(root, 'packed'), { recursive: true });
cpSync(new URL('./stream-comparison.ts', import.meta.url), resolve(root, 'packed/stream-comparison.ts'));
cpSync(new URL('./sustained-client.ts', import.meta.url), resolve(root, 'packed/sustained-client.ts'));
cpSync(new URL('./sustained-resources.ts', import.meta.url), resolve(root, 'packed/sustained-resources.ts'));
cpSync(new URL('./receive-client.ts', import.meta.url), resolve(root, 'packed/receive-client.ts'));
const comparisonCode = await bundleBrowser('packed/stream-comparison.ts');
const receiveCode = await bundleBrowser('packed/receive-client.ts');
const queueCode = await bundleBrowser('experiments/message-queue.ts');
console.log(
  JSON.stringify({
    streamComparisonBytes: Buffer.byteLength(comparisonCode),
    queueModuleBytes: Buffer.byteLength(queueCode),
    queueModuleGzipBytes: gzipSync(queueCode).length,
  }),
);

const engines = process.argv.slice(3);
cpSync(new URL('./node-receive.ts', import.meta.url), resolve(root, 'packed/node-receive.ts'));
const nodeReceivePeer = await startReceivePeer();
try {
  const child = spawn(process.execPath, [resolve(root, 'packed/node-receive.ts'), nodeReceivePeer.url], {
    stdio: 'inherit',
    timeout: 10_000,
  });
  const exit: readonly unknown[] = await once(child, 'exit');
  const [status] = exit;
  assert.equal(status, 0, 'Packed Node receive contract failed');
} finally {
  await nodeReceivePeer.close();
}
cpSync(new URL('./tcp-packet-client.ts', import.meta.url), resolve(root, 'packed/tcp-packet-client.ts'));
execFileSync(process.execPath, [resolve(root, 'packed/tcp-packet-client.ts')], { stdio: 'inherit', timeout: 15_000 });
cpSync(new URL('./websocket-packet-client.ts', import.meta.url), resolve(root, 'packed/websocket-packet-client.ts'));
execFileSync(process.execPath, [resolve(root, 'packed/websocket-packet-client.ts')], { stdio: 'inherit', timeout: 15_000 });
if (engines.length > 0) {
  const playwright = await import('playwright');
  const peer = await startProtocolPeer();
  const receivePeer = await startReceivePeer();
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture writes and ends the native HTTP response.
  const server = createServer((request, response) => {
    if (request.url === '/trace.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
    else if (request.url === '/streams.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(comparisonCode);
    else if (request.url === '/receive.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(receiveCode);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string', 'Expected TCP address');
  try {
    for (const engine of engines) {
      if (engine !== 'chromium' && engine !== 'firefox' && engine !== 'webkit') throw new Error('Unknown browser engine');
      const browser = await playwright[engine].launch();
      try {
        const page = await browser.newPage();
        await page.goto('http://127.0.0.1:' + address.port);
        assert.deepEqual(await page.evaluate(async () => (await import('/trace.js')).trace()), {
          packets: ['connect', 'subscribe', 'publish', 'disconnect', 'connect', 'publish'],
          messages: ['hello'],
          outcome: 'closed before drain',
        });
        const acknowledgedBefore = peer.acknowledgments.length;
        const comparison = await page.evaluate(async (url) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const comparison = (await import('/streams.js')).compareStreams(url);
            const deadline = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                reject(new Error('Packed message source did not settle'));
              }, 8000);
            });
            return await Promise.race([comparison, deadline]);
          } finally {
            clearTimeout(timer);
          }
        }, peer.url);
        for (const result of comparison.results) {
          assert.equal(result.attempted, 2000);
          assert.equal(result.received, 2000);
          assert.equal(result.ordered, true);
          assert.equal(result.checksum, 1_999_000);
          assert.ok(result.peakMessages <= 16);
          assert.ok(result.peakBytes <= 16 * 258);
        }
        assert.deepEqual(comparison.ownership, [
          { mode: 'iterator-break', first: 'first', failure: null, queued: 0 },
          { mode: 'stream-cancel', first: null, failure: null, queued: 0 },
          { mode: 'overflow', first: null, failure: 'Application message queue capacity exceeded', queued: 0 },
        ]);
        assert.deepEqual(comparison.terminal, { drained: true, abortObserved: true, handed: true, handlerFailure: true });
        assert.deepEqual(comparison.cancellation, [
          { mode: 'iterator-return', consumerSettled: true, retiredOnce: true, empty: true },
          { mode: 'iterator-throw', consumerSettled: true, retiredOnce: true, empty: true },
          { mode: 'destination-failure', consumerSettled: true, retiredOnce: true, empty: true },
          { mode: 'pipe-abort', consumerSettled: true, retiredOnce: true, empty: true },
          { mode: 'cancel-during-disconnect', consumerSettled: true, retiredOnce: true, empty: true },
          { mode: 'cancel-after-source-close', consumerSettled: true, retiredOnce: true, empty: true },
        ]);
        assert.deepEqual(comparison.stalledQosOne, {
          received: true,
          heldBeforeRelease: true,
          acknowledged: true,
          queueCleared: true,
        });
        assert.deepEqual(peer.acknowledgments.slice(acknowledgedBefore), [{ messageId: 23, reasonCode: 0 }]);
        assert.deepEqual(peer.commands.slice(peer.commands.lastIndexOf('connect')), [
          'connect',
          'subscribe',
          'publish',
          'pingreq',
          'subscribe',
          'pingreq',
          'puback',
          'pingreq',
          'disconnect',
        ]);
        console.log(JSON.stringify({ engine, ...comparison }));
        const receive = await page.evaluate(async (url) => (await import('/receive.js')).probeReceive(url), receivePeer.url);
        assert.deepEqual(
          receive.accepted,
          ['exact', 'ws-fragments', 'mqtt-split', 'coalesced'].map((mode) => ({
            mode,
            messages: mode === 'coalesced' ? ['hi', 'hi'] : ['hi'],
          })),
        );
        assert.deepEqual(
          receive.rejected,
          ['oversized-connect', 'suback-overflow', 'ping-overflow', 'partial-overflow', 'ws-fragments-overflow'].map((mode) => ({
            mode,
            rangeError: true,
            message: 'WebSocket receive message limit exceeded',
            sameFailure: true,
            delivered: 0,
          })),
        );
        console.log(engine + ' packed receive limits passed');
        const sustainedPage = await browser.newPage();
        try {
          await sustainedPage.goto('http://127.0.0.1:' + address.port);
          const sustained = await sustainedPage.evaluate(async (url) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  reject(new Error('Packed sustained sessions did not settle'));
                }, 16000);
              });
              return await Promise.race([(await import('/streams.js')).probeSustained(url), deadline]);
            } finally {
              clearTimeout(timer);
            }
          }, peer.url);
          assert.deepEqual(
            sustained,
            [0, 1].flatMap((cycle) =>
              ['local', 'abort', 'remote', 'timeout'].map((mode) => ({
                cycle,
                mode,
                received: 128,
                ordered: true,
                checksum: 8128,
                controls: true,
                outcome: true,
                active: { sockets: 1, socketListeners: 3, signalListeners: 1, timers: 0, expired: 0 },
                settled: { sockets: 1, socketListeners: 0, signalListeners: 0, timers: 0, expired: mode === 'timeout' ? 1 : 0 },
                armed: true,
                idle: true,
              })),
            ),
          );
          console.log(JSON.stringify({ engine, sustained }));
          const budget = await sustainedPage.evaluate(
            async (url) => (await import('/streams.js')).probeNativeAdmission(url),
            peer.url,
          );
          assert.equal(budget, 'WebSocket write budget exceeded');
          assert.deepEqual(peer.commands.slice(peer.commands.lastIndexOf('connect')), [
            'connect',
            'pingreq',
            'publish',
            'pingreq',
            'disconnect',
          ]);
          console.log(engine + ' packed QoS 1 admission passed');
          const batchFirst = process.env['MQTT_BATCH_ORDER'] === 'batch-first';
          const wireStart = peer.commands.length;
          const networkBatches = await sustainedPage.evaluate(
            async ({ url, batchFirst }: Readonly<{ url: string; batchFirst: boolean }>) => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const deadline = new Promise<never>((_, reject) => {
                  timer = setTimeout(() => {
                    reject(new Error('Packed batch comparison did not settle'));
                  }, 8000);
                });
                return await Promise.race([(await import('/streams.js')).probeBatchNetwork(url, batchFirst), deadline]);
              } finally {
                clearTimeout(timer);
              }
            },
            { url: peer.url, batchFirst },
          );
          const modes = batchFirst ? ['batch-16', 'iterator'] : ['iterator', 'batch-16'];
          assert.deepEqual(
            networkBatches.map(({ mode }: Readonly<{ mode: string }>) => mode),
            modes,
          );
          const expectedWire = [
            'connect',
            'subscribe',
            'subscribe',
            'publish',
            'pingreq',
            'publish',
            'subscribe',
            'publish',
            'pingreq',
            'disconnect',
          ];
          assert.deepEqual(peer.commands.slice(wireStart), [...expectedWire, ...expectedWire]);
          for (const observation of networkBatches) {
            assert.equal(observation.offered, 128);
            assert.equal(observation.delivered, 128);
            assert.equal(observation.dispatches, observation.mode === 'iterator' ? 128 : 8);
            assert.equal(observation.checksum, 8128);
            assert.equal(observation.ordered, true);
            assert.deepEqual(observation.queue, { messages: 0, bytes: 0, peakMessages: 64, peakBytes: 1216 });
            assert.deepEqual(observation.settled, { sockets: 1, socketListeners: 0, signalListeners: 0, timers: 0, expired: 0 });
            assert.equal(observation.phases.length, 2);
            for (const phase of observation.phases) {
              assert.equal(phase.backlog, 64);
              assert.equal(phase.queuedBytes, 1216);
              for (const duration of [phase.oldestAgeMs, phase.subackMs, phase.pubackMs, phase.pingMs, phase.drainMs]) {
                assert.ok(Number.isFinite(duration) && duration >= 0);
              }
            }
          }
          console.log(JSON.stringify({ engine, networkBatches }));
        } finally {
          await sustainedPage.close();
        }
        console.log(engine + ' ' + browser.version() + ' passed');
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
    await peer.close();
    await receivePeer.close();
  }
}
