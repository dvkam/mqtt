import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate, parser, type Packet } from 'mqtt-packet';
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
const packets: Packet[] = [
  {
    cmd: 'connect',
    protocolId: 'MQTT',
    protocolVersion: 5,
    clean: true,
    keepalive: 0,
    clientId: 'native-ci',
  },
  { cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos: 0 }] },
  { cmd: 'publish', topic, payload, qos: 0, dup: false, retain: false },
  { cmd: 'pingreq' },
  { cmd: 'disconnect' },
];
const requests: number[][] = [];
for (const packet of packets) requests.push(Array.from(generate(packet, codec)));
const entry = resolve(root, 'websocket-session.mjs');
let replies: readonly (readonly number[])[];
let clientMessage: unknown;
if (mode === 'node') {
  const moduleValue: unknown = await import(pathToFileURL(entry).href);
  if (typeof moduleValue !== 'object' || moduleValue === null) throw new Error('Expected packed module');
  if (!('mqttSession' in moduleValue) || typeof moduleValue.mqttSession !== 'function')
    throw new Error('Missing packed export mqttSession');
  if (!('mqttClientSession' in moduleValue) || typeof moduleValue.mqttClientSession !== 'function')
    throw new Error('Missing packed export mqttClientSession');
  const replyValue: unknown = await Reflect.apply(moduleValue.mqttSession, undefined, [url, requests]);
  if (!Array.isArray(replyValue)) throw new Error('Expected packed session reply frames');
  const replyFrames: readonly unknown[] = replyValue;
  if (replyFrames.includes(undefined) || !replyFrames.every(isByteFrame)) throw new Error('Invalid packed session reply frame');
  replies = replyFrames;
  clientMessage = await Reflect.apply(moduleValue.mqttClientSession, undefined, [url]);
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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The HTTP fixture sends the generated browser module using the native response's write and end methods.
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
      async ({ url, requests }: Readonly<{ url: string; requests: readonly (readonly number[])[] }>) => {
        const { mqttSession, mqttClientSession } = await import('/session.js');
        return {
          replies: await mqttSession(url, requests),
          clientMessage: await mqttClientSession(url),
        };
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
const decoded: Packet[] = [];
const decoder = parser(codec);
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Keep the parser's original packets so the wire assertions inspect their broker reason codes and Buffer payload.
decoder.on('packet', (packet) => {
  decoded.push(packet);
});
for (const reply of replies) decoder.parse(Buffer.from(reply));
assert.deepEqual(
  decoded.map(({ cmd }: Readonly<{ cmd: string }>) => cmd),
  ['connack', 'suback', 'publish', 'pingresp'],
);
const [connack, suback, publish] = decoded;
assert.ok(connack?.cmd === 'connack' && suback?.cmd === 'suback' && publish?.cmd === 'publish');
assert.equal(connack.reasonCode, 0);
assert.deepEqual(suback.granted, [0]);
assert.equal(publish.topic, topic);
assert.equal(publish.payload.toString(), payload);
console.log(mode + ' MQTT 5 session passed over ' + new URL(url).protocol);

function isByteFrame(value: unknown): value is readonly number[] {
  if (!Array.isArray(value)) return false;
  const bytes: readonly unknown[] = value;
  return (
    !bytes.includes(undefined) &&
    bytes.every((byte) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
}
