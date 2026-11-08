import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Agent } from 'node:https';
import { createTcpClient, createWebSocketClient } from 'mqtt';

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
/** @type {((packet: import('mqtt-packet').IPublishPacket | undefined) => void) | undefined} */
let receive;
const controller = new AbortController();
/** @type {Pick<Parameters<typeof createTcpClient>[0], 'clientId' | 'onMessage' | 'signal'>} */
const options = {
  clientId: 'packed-ci',
  signal: controller.signal,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  onMessage(packet) {
    receive?.(packet);
  },
};
const url = process.env['MQTT_TEST_WS_URL'];
const ca =
  process.env['MQTT_TEST_CA'] !== undefined && process.env['MQTT_TEST_CA'] !== ''
    ? readFileSync(process.env['MQTT_TEST_CA'])
    : undefined;
const proxy = process.env['MQTT_TEST_PROXY'];
const cert =
  process.env['MQTT_TEST_CERT'] !== undefined && process.env['MQTT_TEST_CERT'] !== ''
    ? readFileSync(process.env['MQTT_TEST_CERT'])
    : undefined;
const key =
  process.env['MQTT_TEST_KEY'] !== undefined && process.env['MQTT_TEST_KEY'] !== ''
    ? readFileSync(process.env['MQTT_TEST_KEY'])
    : undefined;
const agent = proxy !== undefined && proxy !== '' ? new Agent({ proxyEnv: { HTTPS_PROXY: proxy, NO_PROXY: '' } }) : undefined;
const factory =
  url !== undefined && url !== ''
    ? createWebSocketClient({ ...options, url, ca, cert, key, agent, maxWebSocketMessageBytes: 4096 })
    : createTcpClient({ ...options, host: '127.0.0.1', port: Number(process.env['MQTT_TEST_PORT']), maxPacketBytes: 4096 });
const client = await factory.connect();
try {
  await assert.rejects(client.subscribe('ci/\u0000invalid'), /Invalid MQTT topic filter/);
  await client.subscribe('ci/echo');
  await client.ping();
  const samples = [];
  const iterations = Number(process.env['MQTT_TEST_ITERATIONS'] ?? 1);
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    const received = new Promise(
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
      /** @param {(packet: import('mqtt-packet').IPublishPacket | undefined) => void} resolve */ (resolve) => {
        receive = resolve;
      },
    );
    const timer = setTimeout(() => {
      receive?.(undefined);
    }, 3000);
    try {
      await client.publish('ci/echo', String(index));
      const packet = await received;
      assert.ok(packet, 'MQTT echo timed out');
      assert.equal(packet.topic, 'ci/echo');
      assert.equal(packet.payload.toString(), String(index));
      assert.equal(packet.qos, 0);
      samples.push(performance.now() - started);
    } finally {
      clearTimeout(timer);
      receive = undefined;
    }
  }
  const elapsed = performance.now() - start;
  samples.sort((leftMilliseconds, rightMilliseconds) => leftMilliseconds - rightMilliseconds);
  console.log(
    JSON.stringify({
      iterations,
      echoPerSecond: (iterations * 1000) / elapsed,
      p99Ms: samples[Math.ceil(iterations * 0.99) - 1],
    }),
  );
  const cancellation = new Error('packed active cancellation');
  const ping = client.ping().catch((/** @type {unknown} */ error) => error);
  controller.abort(cancellation);
  await assert.rejects(client.publish('ci/echo', 'must not be sent'), (/** @type {unknown} */ error) => error === cancellation);
  await assert.rejects(client.subscribe('ci/echo'), (/** @type {unknown} */ error) => error === cancellation);
  assert.equal(await ping, cancellation);
  console.log('packed active cancellation passed');
} finally {
  await client.disconnect().catch((/** @type {unknown} */ error) => {
    if (!controller.signal.aborted || error !== controller.signal.reason) throw error;
  });
}
