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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `request` is typed `IncomingMessage`, and `Readonly<IncomingMessage>` still fails the rule, so the accepted type would be a hand-written list of the members used here, which has to change with every new use of `request`. The deep read-only type in `src/util/bytes.ts` is not part of the published package, which is all this file imports. `IncomingMessage` is declared in `node:http`. Removing it would cost developer experience. `response` is typed `ServerResponse<IncomingMessage> & { req: IncomingMessage; }`, and `Readonly<ServerResponse<IncomingMessage> & { req: IncomingMessage; }>` still fails the rule, so the accepted type would be a hand-written list of the members used here, which has to change with every new use of `response`. The deep read-only type in `src/util/bytes.ts` is not part of the published package, which is all this file imports. `ServerResponse` is declared in `node:http`.
  const server = createServer((request, response) => {
    if (request.url === '/probe.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>');
  });
  const broker = new WebSocketServer({ server, perMessageDeflate: false });
  const frames: { binary: boolean; bytes: number[] }[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `request` is typed `IncomingMessage`, and `Readonly<IncomingMessage>` still fails the rule, so the accepted type would be a hand-written list of the members used here, which has to change with every new use of `request`. The deep read-only type in `src/util/bytes.ts` is not part of the published package, which is all this file imports. `IncomingMessage` is declared in `node:http`. Removing it would cost developer experience. The handler calls `send`, `terminate` and `pause` on `socket`, which is how this scripted peer answers, stalls or cuts off the client under test. The rule accepts only a read-only type, and that would be false for this parameter.
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
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `bytes` is the `RawData` that ws emits, a `Buffer`, an `ArrayBuffer` or a list of buffers. With `Readonly<RawData>` the call that joins the fragments no longer compiles (TS2769), and the deep read-only type is not part of the published package, which is all this file imports.
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
    const moduleValue: unknown = await import(pathToFileURL(entry).href);
    if (typeof moduleValue !== 'object' || moduleValue === null) throw new Error('Expected packed module');
    if (!('exchange' in moduleValue) || typeof moduleValue.exchange !== 'function')
      throw new Error('Missing packed export exchange');
    if ('exchangeTransport' in moduleValue) throw new Error('The packed browser transport seam should be gone');
    if (!('codecRoundTrip' in moduleValue) || typeof moduleValue.codecRoundTrip !== 'function')
      throw new Error('Missing packed export codecRoundTrip');
    if (!('measureQueue' in moduleValue) || typeof moduleValue.measureQueue !== 'function')
      throw new Error('Missing packed export measureQueue');
    const { exchange, codecRoundTrip, measureQueue } = moduleValue;
    assert.deepEqual(Reflect.apply(codecRoundTrip, undefined, [{ cmd: 'pingreq' }]), [{ cmd: 'pingreq' }]);
    assert.deepEqual(await Reflect.apply(exchange, undefined, [url]), expected);
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('http://' + endpoint);
    assert.deepEqual(await page.evaluate(async () => (await import('/probe.js')).codecRoundTrip({ cmd: 'pingreq' })), [
      { cmd: 'pingreq' },
    ]);
    assert.deepEqual(await page.evaluate(async (url) => (await import('/probe.js')).exchange(url), url), expected);
    assert.deepEqual(frames, [
      { binary: true, bytes: [0xc0, 0] },
      { binary: true, bytes: [0xc0, 0] },
    ]);
    const stalled = url + '/pressure';
    const openWs = async (endpoint: string) => {
      const socket = new WebSocket(endpoint, 'mqtt', { perMessageDeflate: false });
      await once(socket, 'open');
      return socket;
    };
    const wsPressure: unknown = await Reflect.apply(measureQueue, undefined, [stalled, openWs]);
    const nodePressure: unknown = await Reflect.apply(measureQueue, undefined, [stalled]);
    const pressure = {
      ws: wsPressure,
      node: nodePressure,
      chromium: await page.evaluate(async (url) => (await import('/probe.js')).measureQueue(url), stalled),
    };
    for (const observation of Object.values(pressure)) {
      assert.ok(
        typeof observation === 'object' &&
          observation !== null &&
          'nextWouldExceed' in observation &&
          'peak' in observation &&
          typeof observation.peak === 'number' &&
          'budget' in observation &&
          typeof observation.budget === 'number' &&
          'closeMs' in observation &&
          typeof observation.closeMs === 'number',
        'Expected packed WebSocket pressure results',
      );
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
