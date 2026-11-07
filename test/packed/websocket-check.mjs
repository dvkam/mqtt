import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { build } from 'vite';
import WebSocket, { WebSocketServer } from 'ws';

const inputRoot = process.argv[2];
assert.ok(inputRoot !== undefined && inputRoot !== '', 'Expected packed consumer directory');
const root = resolve(inputRoot);
const entry = resolve(root, 'websocket-browser.mjs');
const result = await build({
  root,
  configFile: false,
  logLevel: 'silent',
  build: { write: false, lib: { entry, formats: ['es'] } },
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

if (process.argv.includes('--bundle-only')) {
  console.log(JSON.stringify({ browserBytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length }));
} else {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const server = createServer((request, response) => {
    if (request.url === '/probe.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>');
  });
  const broker = new WebSocketServer({ server, perMessageDeflate: false });
  /** @type {{binary: boolean, bytes: number[]}[]} */
  const frames = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  broker.on('connection', (socket, request) => {
    if (request.url === '/pressure') {
      socket.pause();
      const close = setTimeout(() => {
        socket.terminate();
      }, 500);
      socket.once('close', () => {
        clearTimeout(close);
      });
      return;
    }
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    socket.on('message', (bytes, binary) => {
      const frame = Array.isArray(bytes) ? Buffer.concat(bytes) : bytes instanceof ArrayBuffer ? Buffer.from(bytes) : bytes;
      frames.push({ binary, bytes: Array.from(frame) });
      socket.send(Uint8Array.of(0xd0, 0));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string', 'Expected TCP address');

  let browser;
  try {
    const endpoint = '127.0.0.1:' + address.port;
    const url = 'ws://' + endpoint;
    const expected = { protocol: 'mqtt', bytes: [0xd0, 0] };
    /** @type {unknown} */
    const moduleValue = await import(pathToFileURL(entry).href);
    if (typeof moduleValue !== 'object' || moduleValue === null) throw new Error('Expected packed module');
    if (!('exchange' in moduleValue) || typeof moduleValue.exchange !== 'function')
      throw new Error('Missing packed export exchange');
    if (!('exchangeTransport' in moduleValue) || typeof moduleValue.exchangeTransport !== 'function')
      throw new Error('Missing packed export exchangeTransport');
    if (!('codecRoundTrip' in moduleValue) || typeof moduleValue.codecRoundTrip !== 'function')
      throw new Error('Missing packed export codecRoundTrip');
    if (!('measureQueue' in moduleValue) || typeof moduleValue.measureQueue !== 'function')
      throw new Error('Missing packed export measureQueue');
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture validates each export before invoking the installed module with known test inputs.
    const packedModule = /** @type {typeof import('./websocket-browser.mjs')} */ (moduleValue);
    const { exchange, exchangeTransport, codecRoundTrip, measureQueue } = packedModule;
    assert.deepEqual(codecRoundTrip({ cmd: 'pingreq' }), [{ cmd: 'pingreq' }]);
    assert.deepEqual(await exchange(url), expected);
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('http://' + endpoint);
    assert.deepEqual(await page.evaluate(async () => (await import('/probe.js')).codecRoundTrip({ cmd: 'pingreq' })), [
      { cmd: 'pingreq' },
    ]);
    assert.deepEqual(await page.evaluate(async (url) => (await import('/probe.js')).exchange(url), url), expected);
    assert.deepEqual(await exchangeTransport(url), [0xd0, 0]);
    assert.deepEqual(await page.evaluate(async (url) => (await import('/probe.js')).exchangeTransport(url), url), [0xd0, 0]);
    assert.deepEqual(frames, [
      { binary: true, bytes: [0xc0, 0] },
      { binary: true, bytes: [0xc0, 0] },
      { binary: true, bytes: [0xc0, 0] },
      { binary: true, bytes: [0xc0, 0] },
    ]);
    const stalled = url + '/pressure';
    /** @param {string} endpoint */
    const openWs = async (endpoint) => {
      const socket = new WebSocket(endpoint, 'mqtt', { perMessageDeflate: false });
      await once(socket, 'open');
      return socket;
    };
    const pressure = {
      ws: await measureQueue(stalled, openWs),
      node: await measureQueue(stalled),
      chromium: await page.evaluate(async (url) => (await import('/probe.js')).measureQueue(url), stalled),
    };
    for (const observation of Object.values(pressure)) {
      assert.equal(observation.nextWouldExceed, true);
      assert.ok(observation.peak <= observation.budget);
      assert.ok(observation.closeMs < 3000);
    }
    console.log(JSON.stringify(pressure));
    console.log('Packed WebSocket exchange passed on ' + process.version + ' and Chromium ' + browser.version());
  } finally {
    await browser?.close();
    for (const socket of broker.clients) socket.terminate();
    broker.close();
    server.close();
  }
}
