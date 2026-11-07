import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { build } from 'vite';
import WebSocket, { WebSocketServer } from 'ws';

const root = resolve(process.argv[2]);
const entry = resolve(root, 'websocket-browser.mjs');
const result = await build({
  root,
  configFile: false,
  logLevel: 'silent',
  build: { write: false, lib: { entry, formats: ['es'] } },
});
const chunks = result.flatMap(({ output }) => output).filter(({ type }) => type === 'chunk');
assert.equal(chunks.length, 1);
const [{ code, imports, dynamicImports }] = chunks;
assert.deepEqual([...imports, ...dynamicImports], []);
assert.doesNotMatch(code, /__vite-browser-external|\bBuffer\b|\bnode:/);

if (process.argv.includes('--bundle-only')) {
  console.log(JSON.stringify({ browserBytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length }));
} else {
  const server = createServer((request, response) => {
    if (request.url === '/probe.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>');
  });
  const broker = new WebSocketServer({ server, perMessageDeflate: false });
  const frames = [];
  broker.on('connection', (socket, request) => {
    if (request.url === '/pressure') {
      socket.pause();
      const close = setTimeout(() => socket.terminate(), 500);
      socket.once('close', () => clearTimeout(close));
      return;
    }
    socket.on('message', (bytes, binary) => {
      frames.push({ binary, bytes: Array.from(bytes) });
      socket.send(Uint8Array.of(0xd0, 0));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  let browser;
  try {
    const endpoint = '127.0.0.1:' + server.address().port;
    const url = 'ws://' + endpoint;
    const expected = { protocol: 'mqtt', bytes: [0xd0, 0] };
    const { exchange, exchangeTransport, codecRoundTrip, measureQueue } = await import(pathToFileURL(entry).href);
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
