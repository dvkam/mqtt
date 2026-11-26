import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { createReconnectingClient, createTcpClient } from 'mqtt';

const host = '127.0.0.1';
const brokerPort = Number(process.env['MQTT_TEST_PORT'] ?? 1883);
const topic = `ci/resume/${process.pid}`;

// A TCP proxy in front of the broker, so the check can drop the client's connection without stopping the broker.
/** @type {Set<import('node:net').Socket>} */
const sockets = new Set();
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The connection listener of createServer in node:net receives a native net.Socket, and the proxy calls its mutating pipe and destroy methods.
const proxy = createServer((client) => {
  const upstream = connect(brokerPort, host);
  sockets.add(client);
  sockets.add(upstream);
  const close = () => {
    client.destroy();
    upstream.destroy();
    sockets.delete(client);
    sockets.delete(upstream);
  };
  client.on('error', close).on('close', close);
  upstream.on('error', close).on('close', close);
  client.pipe(upstream).pipe(client);
});
proxy.listen(0, host);
await once(proxy, 'listening');
const address = proxy.address();
assert.ok(address !== null && typeof address !== 'string');

/** @type {{ readonly payload: string, readonly dup: boolean }[]} */
const received = [];
/** @type {import('mqtt').ReconnectEvent[]} */
const events = [];

/** @param {() => boolean} condition */
async function waitFor(condition) {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Timed out');
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

/** @type {NonNullable<import('mqtt').TcpClientOptions['onQosOneMessage']>} */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- TcpClientOptions.onQosOneMessage in src/tcpClient.ts passes a NodeQosOneMessage, whose payload is a native Buffer.
const onQosOneMessage = (message) => {
  received.push({ payload: message.payload.toString(), dup: message.dup });
};

const client = createReconnectingClient(
  createTcpClient,
  {
    host,
    port: address.port,
    clientId: `packed-resume-${process.pid}`,
    sessionExpiryInterval: 60,
    onQosOneMessage,
  },
  {
    resume: true,
    subscriptions: [{ topic: `${topic}/#`, qos: 1 }],
    initialDelayMs: 400,
    onReconnect(event) {
      events.push(event);
    },
  },
);
const publisher = await createTcpClient({ host, port: brokerPort, clientId: `packed-resume-pub-${process.pid}` }).connect();
try {
  const first = await client.session();
  assert.equal(first.connection.sessionPresent, false);
  assert.equal(first.connection.sessionExpiryInterval, 60);
  await publisher.publish(`${topic}/1`, 'before', { qos: 1 });
  await waitFor(() => received.length === 1);

  for (const socket of sockets) socket.destroy();
  await waitFor(() => events.some((event) => event.kind === 'retrying'));
  // The client is away, so the broker queues this message in the session it keeps.
  await publisher.publish(`${topic}/2`, 'while away', { qos: 1 });

  const connectedEvents = () => events.filter((event) => event.kind === 'connected');
  await waitFor(() => connectedEvents().length === 2);
  const second = await client.session();
  assert.notEqual(second, first);
  assert.equal(second.connection.sessionPresent, true);
  const connected = connectedEvents()[1];
  assert.ok(connected?.kind === 'connected');
  assert.equal(connected.generation, 2);
  assert.equal(connected.resumed, true);
  assert.deepEqual(connected.subscriptions, []);
  await waitFor(() => received.length === 2);
  assert.deepEqual(
    received.map(({ payload }) => payload),
    ['before', 'while away'],
  );

  await second.publish(`${topic}/3`, 'resumed', { qos: 1 });
  await waitFor(() => received.length === 3);
  assert.equal(received[2]?.payload, 'resumed');
} finally {
  await client.disconnect().catch(() => {});
  await publisher.disconnect();
  proxy.close();
}
assert.equal(events.at(-1)?.kind, 'stopped');

console.log('Packed session resume kept the subscription and delivered a message published while the client was away');
