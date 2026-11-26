import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { createReconnectingClient, createTcpClient } from 'mqtt';

const host = '127.0.0.1';
const brokerPort = Number(process.env['MQTT_TEST_PORT'] ?? 1883);
const topic = `ci/reconnect/${process.pid}`;

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

/** @type {string[]} */
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

/** @type {NonNullable<import('mqtt').TcpClientOptions['onMessage']>} */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- TcpClientOptions.onMessage in src/tcpClient.ts passes a NodeMessage, whose payload is a native Buffer.
const onMessage = (message) => {
  received.push(message.payload.toString());
};

const client = createReconnectingClient(
  createTcpClient,
  {
    host,
    port: address.port,
    clientId: `packed-reconnect-${process.pid}`,
    onMessage,
  },
  {
    subscriptions: [{ topic: `${topic}/#` }],
    initialDelayMs: 50,
    onReconnect(event) {
      events.push(event);
    },
  },
);
const publisher = await createTcpClient({ host, port: brokerPort, clientId: `packed-reconnect-pub-${process.pid}` }).connect();
try {
  const first = await client.session();
  await publisher.publish(`${topic}/1`, 'before');
  await waitFor(() => received.length === 1);

  for (const socket of sockets) socket.destroy();
  const connectedEvents = () => events.filter((event) => event.kind === 'connected');
  await waitFor(() => connectedEvents().length === 2);
  const second = await client.session();
  assert.notEqual(second, first);
  const connected = connectedEvents()[1];
  assert.ok(connected?.kind === 'connected');
  assert.equal(connected.generation, 2);
  assert.equal(connected.session, second);
  assert.equal(connected.previous?.kind, 'error');
  assert.deepEqual(
    connected.subscriptions.map((restore) => ('result' in restore ? restore.result.reasonCode : -1)),
    [0],
  );

  await publisher.publish(`${topic}/2`, 'after');
  await waitFor(() => received.length === 2);
  assert.deepEqual(received, ['before', 'after']);
} finally {
  await client.disconnect().catch(() => {});
  await publisher.disconnect();
  proxy.close();
}
assert.equal(events.at(-1)?.kind, 'stopped');

console.log('Packed reconnect restored the session and its subscription after a dropped TCP connection');
