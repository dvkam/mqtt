import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate, parser } from 'mqtt-packet';
import { chromium } from 'playwright';
import { build } from 'vite';

const root = resolve(process.argv[2]);
const url = process.argv[3];
const mode = process.argv[4] ?? 'node';
const codec = { protocolVersion: 5 };
const topic = 'ci/native';
const payload = 'native hello';
const requests = [
  { cmd: 'connect', protocolId: 'MQTT', protocolVersion: 5, clean: true, keepalive: 0, clientId: 'native-ci' },
  { cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos: 0 }] },
  { cmd: 'publish', topic, payload, qos: 0, dup: false, retain: false },
  { cmd: 'pingreq' },
  { cmd: 'disconnect' },
].map((packet) => Array.from(generate(packet, codec)));
const entry = resolve(root, 'websocket-session.mjs');
let replies;
let clientMessage;
if (mode === 'node') {
  const { mqttSession, mqttClientSession } = await import(pathToFileURL(entry).href);
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
  const [{ code, imports }] = result.flatMap(({ output }) => output).filter(({ type }) => type === 'chunk');
  assert.deepEqual(imports, []);
  assert.doesNotMatch(code, /__vite-browser-external|\bnode:|\bBuffer\b/);
  const server = createServer((request, response) => {
    if (request.url === '/session.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({
      ...(process.env.MQTT_CHROMIUM_PROXY
        ? { proxy: { server: process.env.MQTT_CHROMIUM_PROXY, bypass: '<-loopback>,127.0.0.1' } }
        : {}),
      env: { ...process.env, ...(process.env.MQTT_CHROMIUM_HOME ? { HOME: process.env.MQTT_CHROMIUM_HOME } : {}) },
    });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port);
    const result = await page.evaluate(
      async ({ url, requests }) => {
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
const decoded = [];
const decoder = parser(codec);
decoder.on('packet', (packet) => decoded.push(packet));
for (const reply of replies) decoder.parse(Buffer.from(reply));
assert.deepEqual(
  decoded.map(({ cmd }) => cmd),
  ['connack', 'suback', 'publish', 'pingresp'],
);
assert.equal(decoded[0].reasonCode, 0);
assert.deepEqual(decoded[1].granted, [0]);
assert.equal(decoded[2].topic, topic);
assert.equal(decoded[2].payload.toString(), payload);
console.log(mode + ' MQTT 5 session passed over ' + new URL(url).protocol);
