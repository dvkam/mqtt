import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Agent } from 'node:https';
import { createTcpClient, createWebSocketClient } from 'mqtt';

/** @typedef {{readonly topic: string, readonly qos: 0, readonly payload: {readonly toString: () => string}}} EchoPacket */
/** @type {((packet: EchoPacket | undefined) => void) | undefined} */
let receive;
const controller = new AbortController();
/** @type {import('mqtt').SessionEnd[]} */
const outcomes = [];
/** @type {string[]} */
const inbound = [];
let releaseInbound = () => {};
let arrivedFirst = () => {};
let arrivedSecond = () => {};
const held = new Promise((resolve) => {
  releaseInbound = () => {
    resolve(undefined);
  };
});
const first = new Promise((resolve) => {
  arrivedFirst = () => {
    resolve(undefined);
  };
});
const second = new Promise((resolve) => {
  arrivedSecond = () => {
    resolve(undefined);
  };
});
/** @type {Pick<Parameters<typeof createTcpClient>[0], 'clientId' | 'onMessage' | 'onQosOneMessage' | 'onSessionEnd' | 'signal'>} */
const options = {
  clientId: 'packed-ci',
  signal: controller.signal,
  onSessionEnd(event) {
    outcomes.push(event);
  },
  /** @param {EchoPacket} packet */
  onMessage(packet) {
    receive?.(packet);
  },
  /** @param {{readonly payload: unknown, readonly qos: 1, readonly messageId: number}} packet */
  async onQosOneMessage(packet) {
    assert.ok(Buffer.isBuffer(packet.payload));
    assert.equal(packet.qos, 1);
    assert.ok(packet.messageId > 0);
    inbound.push(packet.payload.toString());
    if (inbound.length === 1) {
      arrivedFirst();
      await held;
    } else arrivedSecond();
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
    ? createWebSocketClient({ ...options, url, ca, cert, key, agent, maxWebSocketMessageBytes: 4096, maxPacketBytes: 4096 })
    : createTcpClient({ ...options, host: '127.0.0.1', port: Number(process.env['MQTT_TEST_PORT']), maxPacketBytes: 4096 });
const client = await factory.connect();
try {
  await assert.rejects(client.subscribe('ci/\u0000invalid'), /Invalid MQTT topic filter/);
  await Promise.all([client.subscribe('ci/echo'), client.subscribe('ci/other'), client.ping()]);
  await client.subscribe('ci/qos1', { qos: 1 });
  await Promise.all([client.publish('ci/qos1', 'first', { qos: 1 }), client.publish('ci/qos1', 'second', { qos: 1 }), first]);
  await client.ping();
  assert.deepEqual(inbound, ['first']);
  releaseInbound();
  await second;
  assert.deepEqual(inbound, ['first', 'second']);
  const samples = [];
  const iterations = Number(process.env['MQTT_TEST_ITERATIONS'] ?? 1);
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    const received = new Promise(
      /** @param {(packet: EchoPacket | undefined) => void} resolve */ (resolve) => {
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
  await client.unsubscribe('ci/echo');
  const ping = client.ping().catch((/** @type {unknown} */ error) => error);
  controller.abort(cancellation);
  await assert.rejects(client.publish('ci/echo', 'must not be sent'), (/** @type {unknown} */ error) => error === cancellation);
  await assert.rejects(client.subscribe('ci/echo'), (/** @type {unknown} */ error) => error === cancellation);
  assert.equal(await ping, cancellation);
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0];
  assert.equal(outcome?.kind === 'error' && outcome.error, cancellation);
  console.log('packed active cancellation passed');
} finally {
  releaseInbound();
  await client.disconnect().catch((/** @type {unknown} */ error) => {
    if (!controller.signal.aborted || error !== controller.signal.reason) throw error;
  });
}
