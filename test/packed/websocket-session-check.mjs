import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate, parser } from 'mqtt-packet';
import { chromium } from 'playwright';
import { build } from 'vite';

const inputRoot = process.argv[2];
assert.ok(inputRoot !== undefined && inputRoot !== '', 'Expected packed consumer directory');
const root = resolve(inputRoot);
const url = process.argv[3];
assert.ok(url !== undefined && url !== '', 'Expected broker URL');
const mode = process.argv[4] ?? 'node';
const codec = { protocolVersion: 5 };
const topic = 'ci/native';
const payload = 'native hello';
/** @type {import('mqtt-packet').Packet[]} */
const packets = [
  { cmd: 'connect', protocolId: 'MQTT', protocolVersion: 5, clean: true, keepalive: 0, clientId: 'native-ci' },
  { cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos: 0 }] },
  { cmd: 'publish', topic, payload, qos: 0, dup: false, retain: false },
  { cmd: 'pingreq' },
  { cmd: 'disconnect' },
];
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
const requests = packets.map((packet) => Array.from(generate(packet, codec)));
const entry = resolve(root, 'websocket-session.mjs');
let replies;
let clientMessage;
if (mode === 'node') {
  /** @type {unknown} */
  const moduleValue = await import(pathToFileURL(entry).href);
  if (typeof moduleValue !== 'object' || moduleValue === null) throw new Error('Expected packed module');
  if (!('mqttSession' in moduleValue) || typeof moduleValue.mqttSession !== 'function')
    throw new Error('Missing packed export mqttSession');
  if (!('mqttClientSession' in moduleValue) || typeof moduleValue.mqttClientSession !== 'function')
    throw new Error('Missing packed export mqttClientSession');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture validates each export before invoking the installed module with known test inputs.
  const packedModule = /** @type {typeof import('./websocket-session.mjs')} */ (moduleValue);
  const { mqttSession, mqttClientSession } = packedModule;
  replies = await mqttSession(url, requests);
  clientMessage = await mqttClientSession(url);
} else {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry, formats: ['es'] },
    },
  });
  const chunks = [];
  for (const bundle of Array.isArray(result) ? result : [result]) {
    if (!('output' in bundle)) throw new Error('Unexpected Vite watcher');
    for (const entry of bundle.output) {
      if (entry.type === 'chunk') chunks.push(entry);
    }
  }

  const chunk = chunks[0];
  assert.ok(chunk?.type === 'chunk');
  const { code, imports } = chunk;
  assert.deepEqual(imports, []);
  assert.doesNotMatch(code, /__vite-browser-external|\bnode:|\bBuffer\b/);
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const server = createServer((request, response) => {
    if (request.url === '/session.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string', 'Expected TCP address');
  let browser;
  try {
    browser = await chromium.launch({
      ...(process.env['MQTT_CHROMIUM_PROXY'] !== undefined && process.env['MQTT_CHROMIUM_PROXY'] !== ''
        ? { proxy: { server: process.env['MQTT_CHROMIUM_PROXY'], bypass: '<-loopback>,127.0.0.1' } }
        : {}),
      env: {
        ...process.env,
        ...(process.env['MQTT_CHROMIUM_HOME'] !== undefined && process.env['MQTT_CHROMIUM_HOME'] !== ''
          ? { HOME: process.env['MQTT_CHROMIUM_HOME'] }
          : {}),
      },
    });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + address.port);
    const result = await page.evaluate(
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
      async ({ url, requests }) => {
        /** @type {typeof import('./websocket-session.mjs')} */
        const { mqttSession, mqttClientSession } = await import('/session.js');
        return { replies: await mqttSession(url, requests), clientMessage: await mqttClientSession(url) };
      },
      { url, requests },
    );
    replies = result.replies;
    clientMessage = result.clientMessage;
  } finally {
    await browser?.close();
    server.close();
  }
}
assert.deepEqual(clientMessage, { topic: 'ci/browser-client', payload: [104, 101, 108, 108, 111] });
/** @type {import('mqtt-packet').Packet[]} */
const decoded = [];
const decoder = parser(codec);
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
decoder.on('packet', (packet) => {
  decoded.push(packet);
});
for (const reply of replies) decoder.parse(Buffer.from(reply));
assert.deepEqual(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  decoded.map(({ cmd }) => cmd),
  ['connack', 'suback', 'publish', 'pingresp'],
);
const [connack, suback, publish] = decoded;
assert.ok(connack?.cmd === 'connack' && suback?.cmd === 'suback' && publish?.cmd === 'publish');
assert.equal(connack.reasonCode, 0);
assert.deepEqual(suback.granted, [0]);
assert.equal(publish.topic, topic);
assert.equal(publish.payload.toString(), payload);
console.log(mode + ' MQTT 5 session passed over ' + new URL(url).protocol);
