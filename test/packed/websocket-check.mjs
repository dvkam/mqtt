import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import { WebSocketServer } from 'ws';

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
  console.log('Packed WebSocket browser graph has no Node imports');
} else {
  const server = createServer((request, response) => {
    if (request.url === '/probe.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>');
  });
  const broker = new WebSocketServer({ server, perMessageDeflate: false });
  const frames = [];
  broker.on('connection', (socket) => {
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
    const { exchange } = await import(pathToFileURL(entry).href);
    assert.deepEqual(await exchange(url), expected);
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('http://' + endpoint);
    assert.deepEqual(await page.evaluate(async (url) => (await import('/probe.js')).exchange(url), url), expected);
    assert.deepEqual(frames, [
      { binary: true, bytes: [0xc0, 0] },
      { binary: true, bytes: [0xc0, 0] },
    ]);
    console.log('Packed WebSocket exchange passed on ' + process.version + ' and Chromium ' + browser.version());
  } finally {
    await browser?.close();
    for (const socket of broker.clients) socket.terminate();
    broker.close();
    server.close();
  }
}
