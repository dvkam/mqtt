import assert from 'node:assert/strict';
import { createTcpClient } from 'mqtt';

const host = '127.0.0.1';
const port = Number(process.env['MQTT_TEST_PORT'] ?? 1883);
const topic = `ci/publish-properties/${process.pid}`;
const payload = Uint8Array.of(0, 1, 0x7f, 0x80, 0xfe, 0xff);
const correlationData = Uint8Array.of(0xc0, 0xff, 0xee);
/** @type {readonly (readonly [string, string])[]} */
const userProperties = [
  ['trace', 'a'],
  ['trace', 'b'],
];

/** @typedef {NonNullable<import('mqtt').TcpClientOptions['onMessage']>} OnMessage */

/** @returns {{ next: Promise<import('mqtt').NodeMessage>, onMessage: OnMessage }} */
function messageWaiter() {
  /** @type {OnMessage} */
  let resolve = () => {};
  /** @type {Promise<import('mqtt').NodeMessage>} */
  const arrived = new Promise((settle) => {
    resolve = settle;
  });
  /** @type {Promise<never>} */
  const deadline = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('No message arrived'));
    }, 3000).unref();
  });
  return { next: Promise.race([arrived, deadline]), onMessage: resolve };
}

const first = messageWaiter();
const subscriber = await createTcpClient({
  host,
  port,
  clientId: `packed-props-sub-${process.pid}`,
  onMessage: first.onMessage,
}).connect();
const publisher = await createTcpClient({ host, port, clientId: `packed-props-pub-${process.pid}` }).connect();
try {
  await subscriber.subscribe(topic);
  await publisher.publish(topic, payload, {
    qos: 1,
    responseTopic: `${topic}/reply`,
    correlationData,
    contentType: 'application/octet-stream',
    messageExpiryInterval: 60,
    userProperties,
  });
  const message = await first.next;
  assert.deepEqual([...message.payload], [...payload]);
  assert.equal(message.responseTopic, `${topic}/reply`);
  assert.deepEqual([...(message.correlationData ?? [])], [...correlationData]);
  assert.equal(message.contentType, 'application/octet-stream');
  assert.deepEqual(message.userProperties, userProperties);
  assert.ok(message.messageExpiryInterval !== undefined && message.messageExpiryInterval <= 60);

  // A retained message reaches a subscriber that arrives later, with the retain flag set.
  await publisher.publish(`${topic}/retained`, 'kept', { retain: true });
  const late = messageWaiter();
  const latecomer = await createTcpClient({
    host,
    port,
    clientId: `packed-props-late-${process.pid}`,
    onMessage: late.onMessage,
  }).connect();
  try {
    await latecomer.subscribe(`${topic}/retained`);
    const kept = await late.next;
    assert.equal(kept.retain, true);
    assert.equal(kept.payload.toString(), 'kept');
  } finally {
    await publisher.publish(`${topic}/retained`, new Uint8Array(0), { retain: true });
    await latecomer.disconnect();
  }
} finally {
  await publisher.disconnect();
  await subscriber.disconnect();
}
console.log('Packed TCP client published bytes with Response Topic and Correlation Data, and a retained message');
