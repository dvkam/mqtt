import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTransportClient } from 'mqtt';
import { createBrowserClient } from 'mqtt/browser';
import { encodePacket, PacketDecoder } from 'mqtt/codec';
import { createWebSocketClient } from 'mqtt/ws';
import { WebSocketServer } from 'ws';

/** @param {number | undefined} connack The actual MQTT reason, or undefined to withhold a reply. */
function peer(connack) {
  /** @type {number[]} */
  const writes = [];
  /** @type {boolean[]} */
  const closes = [];
  let opens = 0;
  /** @type {import('mqtt').ByteTransport} */
  const bytes = {
    name: 'Recovery fixture',
    async open(/** @type {Readonly<import('mqtt').ByteInbound>} */ inbound) {
      opens++;
      return Promise.resolve({
        bufferedBytes: 0,
        async write(/** @type {import('mqtt').ReadonlyBytes} */ packet) {
          writes.push(packet[0] ?? -1);
          if (packet[0] === 0x10 && connack !== undefined)
            inbound.bytes(encodePacket({ cmd: 'connack', sessionPresent: false, reasonCode: connack }));
          return Promise.resolve();
        },
        async close(force) {
          closes.push(force);
          return Promise.resolve();
        },
      });
    },
  };
  return { bytes, writes, closes, opens: () => opens };
}

const refused = peer(0x87);
const refusedFactory = createTransportClient(refused.bytes, { clientId: 'refused' });
const opening = refusedFactory.connect();
await assert.rejects(opening, { code: 'ERR_MQTT_REFUSED', reasonCode: 0x87, fatal: true });
assert.equal(refusedFactory.connect(), opening);
assert.equal(refused.opens(), 1);
assert.deepEqual(refused.closes, [true]);
const accepted = peer(0);
await (await createTransportClient(accepted.bytes, { clientId: 'retry' }).connect()).disconnect();
assert.deepEqual(accepted.writes, [0x10, 0xe0]);

const stalled = peer(undefined);
const deadline = createTransportClient(stalled.bytes, { clientId: 'deadline', timeoutMs: 25 });
await assert.rejects(deadline.connect(), { code: 'ERR_MQTT_TIMEOUT', fatal: true });
assert.deepEqual(stalled.writes, [0x10]);
assert.deepEqual(stalled.closes, [true]);

const canceled = new Error('first connection canceled');
const premature = peer(0);
const preaborted = createTransportClient(premature.bytes, { clientId: 'cancel', signal: AbortSignal.abort(canceled) });
/** @param {unknown} reason */
const originalCancellation = (reason) => reason === canceled;
await assert.rejects(preaborted.connect(), originalCancellation);
assert.equal(premature.opens(), 0);

const full = peer(0);
const controller = new AbortController();
const client = await createTransportClient(full.bytes, {
  clientId: 'capacity',
  signal: controller.signal,
  maxPendingPublishes: 1,
}).connect();
const admitted = client.publish('example/admitted', 'first', { qos: 1 });
try {
  assert.deepEqual(full.writes, [0x10, 0x32]);
  await assert.rejects(client.publish('example/refused', 'next', { qos: 1 }), { code: 'ERR_MQTT_CAPACITY', fatal: false });
  assert.deepEqual(full.writes, [0x10, 0x32]);
  controller.abort(canceled);
  await assert.rejects(admitted, originalCancellation);
  await assert.rejects(client.publish('example/new', 'new session needed'), originalCancellation);
} finally {
  controller.abort(canceled);
  await admitted.catch(() => {});
  await assert.rejects(client.disconnect(), originalCancellation);
}

for (const factory of [createBrowserClient, createWebSocketClient]) {
  await assert.rejects(factory({ url: 'invalid://mqtt', clientId: 'invalid-url' }).connect());
}

const broker = new WebSocketServer({ host: '127.0.0.1', port: 0 });
try {
  await once(broker, 'listening');
  const address = broker.address();
  assert.ok(address !== null && typeof address !== 'string');
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The handler calls `send` on `socket`, which is how this scripted broker answers the client under test. The rule accepts only a read-only type, and that would be false for this parameter.
  broker.on('connection', (socket) => {
    const decoder = new PacketDecoder();
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `bytes` is typed `RawData`, and `Readonly<import('ws').RawData>` still fails the rule, so the accepted type would be a hand-written list of the members used here, which has to change with every new use of `bytes`. The deep read-only type in `src/util/bytes.ts` is not part of the published package, which is all this file imports. `RawData` is declared in `ws`.
    socket.on('message', (bytes) => {
      assert.ok(Buffer.isBuffer(bytes));
      for (const packet of decoder.push(bytes)) {
        if (packet.cmd === 'connect') {
          assert.equal(packet.username, 'sample');
          assert.deepEqual(packet.password, Uint8Array.of(1));
          socket.send(encodePacket({ cmd: 'connack', sessionPresent: false, reasonCode: 0 }));
        }
      }
    });
  });
  const browserOptions = {
    url: 'ws://127.0.0.1:' + address.port,
    clientId: 'browser-profile',
    username: 'sample',
    password: Uint8Array.of(1),
  };
  await (await createBrowserClient(browserOptions).connect()).disconnect();
} finally {
  for (const socket of broker.clients) socket.terminate();
  broker.close();
}

console.log('Packed recovery checked refusal and retry, timeout, cancellation, write admission, invalid URLs and browser options');
