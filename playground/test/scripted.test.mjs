// Checks the scripted broker against MQTT 5 through its byte transport. Run from the repository root after installing
// the packed tarball into playground.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as macrotask } from 'node:timers/promises';
import { encodePacket, PacketDecoder } from 'mqtt/codec';
import { matches, scriptedBroker } from '../src/scripted.ts';

const context = { signal: new AbortController().signal, timeoutMs: 1000 };
const empty = new Uint8Array(0);
const text = new TextDecoder();

/** A scripted broker and the client side of its connections. */
function harness() {
  const broker = scriptedBroker();
  /** Opens a connection, sends CONNECT and returns the writer with the packets the broker sends. */
  const connect = async (withWill = false) => {
    const decoder = new PacketDecoder();
    /** @type {import('mqtt/codec').WirePacket[]} */
    const received = [];
    const writer = await broker.transport.open(
      {
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteInbound.bytes in byteTransport.d.ts of the packed client takes the broker's bytes as a native Uint8Array.
        bytes(chunk) {
          received.push(...decoder.push(chunk));
        },
        end() {},
        fail() {},
      },
      context,
    );
    const will = { topic: 'status', payload: new TextEncoder().encode('offline'), retain: true };
    await writer.write(encodePacket({ cmd: 'connect', clientId: 'test', ...(withWill ? { will } : {}) }));
    return { writer, received };
  };
  /** The retained messages that a new connection receives for the filter `#`. */
  const retained = async () => {
    const { writer, received } = await connect();
    await writer.write(encodePacket({ cmd: 'subscribe', messageId: 1, topics: ['#'], qos: 1 }));
    await macrotask();
    await writer.write(encodePacket({ cmd: 'disconnect', reasonCode: 0 }));
    await writer.close(false);
    const found = [];
    for (const packet of received)
      if (packet.cmd === 'publish') found.push(`${packet.topic} ${text.decode(packet.payload)} retain=${String(packet.retain)}`);
    return found;
  };
  return { broker, connect, retained };
}

await test('a topic filter matches as MQTT 4.7 defines', () => {
  assert.equal(matches('a/#', 'a'), true);
  assert.equal(matches('a/#', 'a/b/c'), true);
  assert.equal(matches('a/+', 'a/b'), true);
  assert.equal(matches('a/+', 'a'), false);
  assert.equal(matches('a/+', 'a/b/c'), false);
  assert.equal(matches('#', '$SYS/uptime'), false);
  assert.equal(matches('+/uptime', '$SYS/uptime'), false);
  assert.equal(matches('$SYS/#', '$SYS/uptime'), true);
});

await test('the Packet Identifier of a delivery runs from 1 to 65,535 and then starts at 1 again', async () => {
  const { writer, received } = await harness().connect();
  await writer.write(encodePacket({ cmd: 'subscribe', messageId: 1, topics: ['t'], qos: 1 }));
  for (let count = 0; count < 65_537; count++)
    await writer.write(encodePacket({ cmd: 'publish', topic: 't', payload: empty, qos: 1, messageId: 1 }));
  await macrotask();
  const identifiers = [];
  for (const packet of received) if (packet.cmd === 'publish' && packet.qos === 1) identifiers.push(packet.messageId);
  assert.equal(identifiers.length, 65_537);
  assert.deepEqual(identifiers.slice(65_533), [65_534, 65_535, 1, 2]);
  assert.equal(new Set(identifiers.slice(0, 65_535)).size, 65_535);
});

await test('a delivery takes the lower of the granted and the published QoS, and CONNACK allows QoS 1 at most', async () => {
  const { writer, received } = await harness().connect();
  await writer.write(encodePacket({ cmd: 'subscribe', messageId: 1, topics: ['low'], qos: 0 }));
  await writer.write(encodePacket({ cmd: 'subscribe', messageId: 2, topics: ['high'], qos: 1 }));
  await writer.write(encodePacket({ cmd: 'publish', topic: 'low', payload: empty, qos: 1, messageId: 3 }));
  await writer.write(encodePacket({ cmd: 'publish', topic: 'high', payload: empty }));
  await writer.write(encodePacket({ cmd: 'publish', topic: 'high', payload: empty, qos: 1, messageId: 4 }));
  await macrotask();
  const deliveries = [];
  let maximumQoS;
  for (const packet of received) {
    if (packet.cmd === 'connack') ({ maximumQoS } = packet);
    if (packet.cmd === 'publish') deliveries.push(`${packet.topic} ${String(packet.qos ?? 0)}`);
  }
  assert.equal(maximumQoS, 1);
  assert.deepEqual(deliveries, ['low 0', 'high 0', 'high 1']);
});

await test('a retained message stays until an empty retained payload removes it', async () => {
  const { connect, retained } = harness();
  const payload = new TextEncoder().encode('on');
  const first = await connect();
  await first.writer.write(encodePacket({ cmd: 'publish', topic: 'kept', payload, retain: true }));
  await first.writer.write(encodePacket({ cmd: 'publish', topic: 'not-kept', payload }));
  await first.writer.write(encodePacket({ cmd: 'disconnect', reasonCode: 0 }));
  await first.writer.close(false);
  assert.deepEqual(await retained(), ['kept on retain=true']);
  const second = await connect();
  await second.writer.write(encodePacket({ cmd: 'publish', topic: 'kept', payload: empty, retain: true }));
  await second.writer.close(false);
  assert.deepEqual(await retained(), []);
});

await test('the Will is published unless the client sent DISCONNECT with reason 0x00', async () => {
  const { broker, connect, retained } = harness();
  const normal = await connect(true);
  await normal.writer.write(encodePacket({ cmd: 'disconnect', reasonCode: 0 }));
  await normal.writer.close(false);
  assert.deepEqual(await retained(), []);

  const withWill = await connect(true);
  await withWill.writer.write(encodePacket({ cmd: 'disconnect', reasonCode: 4 }));
  await withWill.writer.close(false);
  assert.deepEqual(await retained(), ['status offline retain=true']);

  const second = await connect();
  await second.writer.write(encodePacket({ cmd: 'publish', topic: 'status', payload: empty, retain: true }));
  await second.writer.close(false);
  await connect(true);
  assert.equal(broker.drop(), true);
  assert.equal(broker.drop(), false);
  assert.deepEqual(await retained(), ['status offline retain=true']);
});
