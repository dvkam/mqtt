import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { startProtocolPeer } from '../experiments/protocol-peer.ts';
import { checkSsrConsumer } from './ssr-check.ts';

const inputRoot = process.argv[2];
assert.ok(inputRoot !== undefined && inputRoot !== '', 'Expected packed consumer directory');
const root = resolve(inputRoot);
await checkSsrConsumer(root);
cpSync(new URL('./browser', import.meta.url), resolve(root, 'browser'), { recursive: true });
execFileSync(
  process.execPath,
  [fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)), '-p', resolve(root, 'browser/tsconfig.json')],
  { stdio: 'inherit' },
);
/** @param {string} entry */
async function bundleBrowser(entry) {
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
const comparisonCode = await bundleBrowser('packed/stream-comparison.ts');
const queueCode = await bundleBrowser('experiments/message-queue.ts');
console.log(
  JSON.stringify({
    streamComparisonBytes: Buffer.byteLength(comparisonCode),
    queueModuleBytes: Buffer.byteLength(queueCode),
    queueModuleGzipBytes: gzipSync(queueCode).length,
  }),
);

const engines = process.argv.slice(3);
if (engines.length > 0) {
  const playwright = await import('playwright');
  const peer = await startProtocolPeer();
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const server = createServer((request, response) => {
    if (request.url === '/trace.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
    else if (request.url === '/streams.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(comparisonCode);
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
        const comparison = await page.evaluate(async (url) => (await import('/streams.js')).compareStreams(url), peer.url);
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
        assert.deepEqual(comparison.terminal, { idleClosed: true, idleFailure: true, handed: true });
        console.log(JSON.stringify({ engine, ...comparison }));
        console.log(engine + ' ' + browser.version() + ' passed');
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
    await peer.close();
  }
}
