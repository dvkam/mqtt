import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { createReconnectingClient, createTcpClient } from 'mqtt';

const host = '127.0.0.1';
const brokerPort = Number(process.env['MQTT_TEST_PORT'] ?? 1883);
const topic = `ci/qos2/${process.pid}`;
const PUBREC = 5;
const PUBREL = 6;

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

// A TCP proxy in front of the broker. `cut` names one packet type and its sender. When that packet arrives, the proxy
// drops it and closes the connection, so the check decides which packet of an exchange is lost.
/** @type {{ from: 'client' | 'broker', type: number } | undefined} */
let cut;
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Developer experience: createServer in node:net hands its connection listener a native net.Socket, and the proxy has to call its write and destroy methods. No readonly type of a socket allows that.
const proxy = createServer((client) => {
  const upstream = connect(brokerPort, host);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  /**
   * Forward each complete MQTT packet that one side sent to the other side.
   * @param {'client' | 'broker'} from
   */
  const relay = (from) => {
    const to = from === 'client' ? upstream : client;
    let pending = Buffer.alloc(0);
    /** @param {Buffer} chunk */
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Developer experience: the data event of net.Socket in node:net hands its listener a native Buffer, and no readonly type takes one.
    return (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        let length = 0;
        let index = 1;
        for (let multiplier = 1; ; multiplier *= 128) {
          const digit = pending[index++];
          if (digit === undefined) return;
          length += (digit & 127) * multiplier;
          if ((digit & 128) === 0) break;
        }
        if (pending.length < index + length) return;
        if (cut?.from === from && cut.type === (pending[0] ?? 0) >> 4) {
          cut = undefined;
          close();
          return;
        }
        to.write(pending.subarray(0, index + length));
        pending = pending.subarray(index + length);
      }
    };
  };
  client.on('data', relay('client')).on('error', close).on('close', close);
  upstream.on('data', relay('broker')).on('error', close).on('close', close);
});
proxy.listen(0, host);
await once(proxy, 'listening');
const address = proxy.address();
assert.ok(address !== null && typeof address !== 'string');

/** @type {string[]} */
const peerReceived = [];
/** @type {{ readonly payload: string, readonly dup: boolean }[]} */
const clientReceived = [];
/** @type {import('mqtt').ReconnectEvent[]} */
const events = [];

/** @param {Readonly<{ payload: Readonly<{ toString(): string }> }>} message */
const onPeerMessage = (message) => {
  peerReceived.push(message.payload.toString());
};
/** @param {Readonly<{ payload: Readonly<{ toString(): string }>, dup: boolean }>} message */
const onClientMessage = (message) => {
  clientReceived.push({ payload: message.payload.toString(), dup: message.dup });
};
const unexpectedQosOne = () => {
  throw new Error('The broker delivered a QoS 2 publication at QoS 1');
};

const peer = await createTcpClient({
  host,
  port: brokerPort,
  clientId: `packed-qos2-peer-${process.pid}`,
  onQosOneMessage: unexpectedQosOne,
  onQosTwoMessage: onPeerMessage,
}).connect();
const client = createReconnectingClient(
  createTcpClient,
  {
    host,
    port: address.port,
    clientId: `packed-qos2-${process.pid}`,
    sessionExpiryInterval: 60,
    onQosOneMessage: unexpectedQosOne,
    onQosTwoMessage: onClientMessage,
  },
  {
    resume: true,
    subscriptions: [{ topic: `${topic}/in/#`, qos: 2 }],
    initialDelayMs: 200,
    onReconnect(event) {
      events.push(event);
    },
  },
);

/**
 * The session of the nth `connected` event, counted from 1.
 * @param {number} generation
 */
async function sessionOf(generation) {
  await waitFor(() => events.some((event) => event.kind === 'connected' && event.generation === generation));
  return client.session();
}

/**
 * The publications the nth `connected` event lists in `resent`, without their Packet Identifiers.
 * @param {number} generation
 */
function resent(generation) {
  const event = events.find((candidate) => candidate.kind === 'connected' && candidate.generation === generation);
  assert.ok(event?.kind === 'connected');
  return (event.resent ?? []).map(({ topic: name, qos, acknowledged }) => ({ topic: name, qos, acknowledged }));
}

/**
 * The `pubrec` and `pubcomp` events for a topic, as `kind reasonCode`.
 * @param {string} name
 */
function acknowledgments(name) {
  /** @type {string[]} */
  const list = [];
  for (const event of events)
    if ((event.kind === 'pubrec' || event.kind === 'pubcomp') && event.topic === name)
      list.push(`${event.kind} ${event.reasonCode}`);
  return list;
}

try {
  assert.deepEqual(await peer.subscribe(`${topic}/out/#`, { qos: 2 }), { grantedQos: 2, reasonCode: 2 });
  const first = await sessionOf(1);
  assert.equal(first.connection.maximumQos, 2);
  const [connected] = events;
  assert.ok(connected?.kind === 'connected');
  assert.deepEqual(connected.subscriptions, [{ topic: `${topic}/in/#`, qos: 2, result: { grantedQos: 2, reasonCode: 2 } }]);

  // Both directions on one connection. Each publish promise resolves on PUBCOMP.
  /** @type {string[]} */
  const batch = [];
  for (let index = 0; index < 10; index++) batch.push(`round trip ${index}`);
  await Promise.all(batch.map(async (payload) => first.publish(`${topic}/out/batch`, payload, { qos: 2 })));
  await Promise.all(batch.map(async (payload) => peer.publish(`${topic}/in/batch`, payload, { qos: 2 })));
  await waitFor(() => peerReceived.length >= batch.length && clientReceived.length >= batch.length);
  assert.deepEqual(peerReceived, batch);
  assert.deepEqual(
    clientReceived,
    batch.map((payload) => ({ payload, dup: false })),
  );

  // The connection ends before the client reads PUBREC. The resumed session sends the PUBLISH again with DUP.
  cut = { from: 'broker', type: PUBREC };
  await assert.rejects(first.publish(`${topic}/out/a`, 'PUBREC lost', { qos: 2 }));
  const second = await sessionOf(2);
  assert.equal(second.connection.sessionPresent, true);
  assert.deepEqual(resent(2), [{ topic: `${topic}/out/a`, qos: 2, acknowledged: false }]);
  await waitFor(() => acknowledgments(`${topic}/out/a`).length === 2);
  assert.deepEqual(acknowledgments(`${topic}/out/a`), ['pubrec 0', 'pubcomp 0']);

  // The connection ends before the broker reads PUBREL. The resumed session sends only the PUBREL again.
  cut = { from: 'client', type: PUBREL };
  await assert.rejects(second.publish(`${topic}/out/b`, 'PUBREL lost', { qos: 2 }));
  const third = await sessionOf(3);
  assert.equal(third.connection.sessionPresent, true);
  assert.deepEqual(resent(3), [{ topic: `${topic}/out/b`, qos: 2, acknowledged: true }]);
  await waitFor(() => acknowledgments(`${topic}/out/b`).length === 1);
  assert.deepEqual(acknowledgments(`${topic}/out/b`), ['pubcomp 0']);

  // The connection ends before the broker reads the client's PUBREC, so the broker sends its PUBLISH again. The handler
  // already has the message and does not run a second time.
  cut = { from: 'client', type: PUBREC };
  await peer.publish(`${topic}/in/c`, 'inbound PUBREC lost', { qos: 2 });
  const fourth = await sessionOf(4);
  assert.equal(fourth.connection.sessionPresent, true);
  // With Receive Maximum 1 the broker sends this publication only after the PUBCOMP of the one before it.
  await peer.publish(`${topic}/in/d`, 'after the duplicate', { qos: 2 });
  await waitFor(() => clientReceived.at(-1)?.payload === 'after the duplicate');
  await fourth.publish(`${topic}/out/e`, 'last', { qos: 2 });
  await waitFor(() => peerReceived.includes('last'));

  assert.deepEqual(peerReceived.slice(batch.length), ['PUBREC lost', 'PUBREL lost', 'last']);
  assert.deepEqual(clientReceived.slice(batch.length), [
    { payload: 'inbound PUBREC lost', dup: false },
    { payload: 'after the duplicate', dup: false },
  ]);
} finally {
  await client.disconnect().catch(() => {});
  await peer.disconnect();
  proxy.close();
}

console.log(
  'Packed TCP clients exchanged QoS 2 publications through Mosquitto, each delivered once, across a lost PUBREC and a lost PUBREL',
);
