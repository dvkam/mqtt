import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Agent } from 'node:https';
import { createTcpClient, createWebSocketClient } from 'mqtt';

let receive;
const options = {
  clientId: 'packed-ci',
  onMessage(packet) {
    receive?.(packet);
  },
};
const url = process.env.MQTT_TEST_WS_URL;
const ca = process.env.MQTT_TEST_CA ? readFileSync(process.env.MQTT_TEST_CA) : undefined;
const proxy = process.env.MQTT_TEST_PROXY;
const cert = process.env.MQTT_TEST_CERT ? readFileSync(process.env.MQTT_TEST_CERT) : undefined;
const key = process.env.MQTT_TEST_KEY ? readFileSync(process.env.MQTT_TEST_KEY) : undefined;
const agent = proxy ? new Agent({ proxyEnv: { HTTPS_PROXY: proxy, NO_PROXY: '' } }) : undefined;
const factory = url
  ? createWebSocketClient({ ...options, url, ca, cert, key, agent })
  : createTcpClient({ ...options, host: '127.0.0.1', port: Number(process.env.MQTT_TEST_PORT) });
const client = await factory.connect();
try {
  await client.subscribe('ci/echo');
  await client.ping();
  const samples = [];
  const iterations = Number(process.env.MQTT_TEST_ITERATIONS ?? 1);
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    const received = new Promise((resolve) => {
      receive = resolve;
    });
    const timer = setTimeout(() => receive(undefined), 3000);
    try {
      await client.publish('ci/echo', String(index));
      const packet = await received;
      assert.equal(packet?.topic, 'ci/echo');
      assert.equal(packet.payload.toString(), String(index));
      assert.equal(packet.qos, 0);
      samples.push(performance.now() - started);
    } finally {
      clearTimeout(timer);
      receive = undefined;
    }
  }
  const elapsed = performance.now() - start;
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      iterations,
      echoPerSecond: (iterations * 1000) / elapsed,
      p99Ms: samples[Math.ceil(iterations * 0.99) - 1],
    }),
  );
} finally {
  await client.disconnect();
}
