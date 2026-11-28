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
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteTransport.open in src/byteTransport.ts declares these parameters. ByteInbound declares methods and OpenContext holds a native AbortSignal, and the rule counts both as mutable. A type the rule accepts would be a second copy of the public interfaces that every transport author would have to keep in step.
    async open(inbound) {
      opens++;
      return Promise.resolve({
        bufferedBytes: 0,
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteWriter.write in src/byteTransport.ts declares this Uint8Array. A byte view has no read-only form, because Readonly<Uint8Array> keeps the writable index signature. A type the rule accepts would force a copy of every chunk before a native call takes it.
        async write(packet) {
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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The ws server emits its WebSocket class. A read-only type for it would leave out on and send, which this handler calls.
  broker.on('connection', (socket) => {
    const decoder = new PacketDecoder();
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ws emits the message as a Buffer, an ArrayBuffer or a Buffer array, and none of them has a read-only form. A type the rule accepts would force a copy before PacketDecoder.push takes the bytes.
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
