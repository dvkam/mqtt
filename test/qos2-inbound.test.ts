import { expect, test } from 'vitest';
import type { ByteInbound, ByteTransport } from '../src/byteTransport.js';
import type { BrokerPacket } from '../src/codec.js';
import { createTransportClient, type ByteClientOptions, type SessionEnd } from '../src/portableClient.js';
import { exchangeBroker, settle, type ExchangeScript } from './experiments/exchange-broker.js';
import { utf8 } from './experiments/portable-packets.js';

const decoder = new TextDecoder();

/** A QoS 2 PUBLISH of 'hi' to topic 'a' with Packet Identifier 7. */
function publishBytes(dup: boolean): number[] {
  return [dup ? 0x3c : 0x34, 8, 0, 1, 0x61, 0, 7, 0, 0x68, 0x69];
}

function publication(messageId: number, qos: 1 | 2 = 2, dup = false): BrokerPacket {
  return { cmd: 'publish', topic: 'a', payload: utf8('hi'), qos, messageId, dup };
}

/** The PUBACK, PUBREC, PUBREL, PUBCOMP and DISCONNECT frames among the frames the client wrote. */
function answers(frames: readonly (readonly number[])[]): (readonly number[])[] {
  return frames.filter((frame) => {
    const type = (frame[0] ?? 0) >> 4;
    return (type >= 4 && type <= 7) || type === 14;
  });
}

type Handlers = Readonly<Pick<ByteClientOptions, 'onMessage' | 'onQosOneMessage' | 'onQosTwoMessage'>>;

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
}

async function receiver(script: Readonly<ExchangeScript> = {}, options: Handlers = {}) {
  const peer = exchangeBroker(script);
  const delivered: number[] = [];
  const ends: SessionEnd[] = [];
  const session = await createTransportClient(peer.transport, {
    clientId: 'receiver',
    onQosOneMessage() {},
    onQosTwoMessage(message: Readonly<{ messageId: number }>) {
      delivered.push(message.messageId);
    },
    onSessionEnd(event) {
      ends.push(event);
    },
    ...options,
  }).connect();
  return { session, connection: peer.connection(0), delivered, ends, releaseWrites: peer.releaseWrites };
}

test('a duplicate QoS 2 PUBLISH gets PUBREC again and reaches the handler once', async () => {
  const peer = exchangeBroker();
  const delivered: string[] = [];
  const session = await createTransportClient(peer.transport, {
    clientId: 'receiver',
    onQosOneMessage() {},
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- PortableOptions.onQosTwoMessage in src/portable.ts passes the message with the adapter's mutable Uint8Array payload.
    onQosTwoMessage(message) {
      delivered.push([message.topic, message.messageId, message.qos, message.dup, decoder.decode(message.payload)].join(' '));
    },
  }).connect();
  await session.subscribe('a', { qos: 2 });
  const connection = peer.connection(0);
  connection.deliverBytes(publishBytes(false));
  await settle();
  expect(delivered).toEqual(['a 7 2 false hi']);
  expect(connection.frames.slice(1)).toEqual([[0x50, 2, 0, 7]]);
  connection.deliverBytes(publishBytes(true));
  await settle();
  connection.deliverBytes(publishBytes(false));
  await settle();
  expect(connection.frames.slice(1)).toEqual([
    [0x50, 2, 0, 7],
    [0x50, 2, 0, 7],
    [0x50, 2, 0, 7],
  ]);
  // PUBREL for Packet Identifier 7 gets PUBCOMP in its shortest form.
  connection.deliverBytes([0x62, 2, 0, 7]);
  await settle();
  expect(connection.frames.slice(4)).toEqual([[0x70, 2, 0, 7]]);
  expect(delivered).toEqual(['a 7 2 false hi']);
  await session.disconnect();
});

test('a second PUBREL gets PUBCOMP with reason 0x92, and the identifier then names a new message', async () => {
  const { session, connection, delivered } = await receiver();
  connection.deliver(publication(7));
  await settle();
  connection.deliver({ cmd: 'pubrel', messageId: 7, reasonCode: 0 });
  await settle();
  connection.deliver({ cmd: 'pubrel', messageId: 7, reasonCode: 0 });
  await settle();
  expect(answers(connection.frames)).toEqual([
    [0x50, 2, 0, 7],
    [0x70, 2, 0, 7],
    [0x70, 3, 0, 7, 0x92],
  ]);
  expect(delivered).toEqual([7]);
  // MQTT-4.3.3-12: after PUBCOMP a PUBLISH with the same Packet Identifier is a new Application Message.
  connection.deliver(publication(7));
  await settle();
  expect(delivered).toEqual([7, 7]);
  expect(answers(connection.frames).at(-1)).toEqual([0x50, 2, 0, 7]);
  await session.disconnect();
});

test('a PUBREL for an unknown Packet Identifier gets PUBCOMP with reason 0x92 and delivers nothing', async () => {
  const { session, connection, delivered } = await receiver();
  connection.deliver({ cmd: 'pubrel', messageId: 9, reasonCode: 0 });
  await settle();
  expect(answers(connection.frames)).toEqual([[0x70, 3, 0, 9, 0x92]]);
  expect(delivered).toEqual([]);
  await session.ping();
  await session.disconnect();
});

test('a broker Maximum Packet Size of 4 gets the PUBCOMP for an unknown PUBREL without a reason code', async () => {
  const { session, connection } = await receiver({ connack: () => ({ maximumPacketSize: 4 }) });
  connection.deliver({ cmd: 'pubrel', messageId: 9, reasonCode: 0 });
  await settle();
  expect(answers(connection.frames)).toEqual([[0x70, 2, 0, 9]]);
  await session.disconnect();
});

test('PUBREC follows the handler, and a duplicate PUBLISH while it runs starts no second delivery', async () => {
  const handler = gate();
  let calls = 0;
  const { session, connection } = await receiver(
    {},
    {
      async onQosTwoMessage() {
        calls++;
        await handler.promise;
      },
    },
  );
  connection.deliver(publication(7));
  await settle();
  connection.deliver(publication(7, 2, true));
  await settle();
  expect(calls).toBe(1);
  expect(answers(connection.frames)).toEqual([]);
  // Control packets do not wait for the handler.
  await session.ping();
  handler.release();
  await settle();
  expect(calls).toBe(1);
  expect(answers(connection.frames)).toEqual([[0x50, 2, 0, 7]]);
  await session.disconnect();
});

test('a handler that throws ends the session without PUBREC', async () => {
  const failure = new Error('store failed');
  const { session, connection, ends } = await receiver(
    {},
    {
      onQosTwoMessage() {
        throw failure;
      },
    },
  );
  connection.deliver(publication(7));
  await settle();
  expect(answers(connection.frames)).toEqual([]);
  expect(ends).toEqual([{ kind: 'error', error: failure }]);
  await expect(session.ping()).rejects.toBe(failure);
});

test('a PUBREL that arrives while the handler runs is a protocol error with reason 0x82', async () => {
  const handler = gate();
  const { session, connection } = await receiver(
    {},
    {
      async onQosTwoMessage() {
        await handler.promise;
      },
    },
  );
  connection.deliver(publication(7));
  await settle();
  connection.deliver({ cmd: 'pubrel', messageId: 7, reasonCode: 0 });
  await settle();
  expect(answers(connection.frames)).toEqual([[0xe0, 1, 0x82]]);
  await expect(session.ping()).rejects.toMatchObject({
    code: 'ERR_MQTT_PROTOCOL',
    reasonCode: 0x82,
    message: 'MQTT PUBREL arrived before PUBREC',
  });
  handler.release();
  await settle();
  expect(answers(connection.frames)).toEqual([[0xe0, 1, 0x82]]);
});

test('a QoS 2 handler alone advertises Receive Maximum 1', async () => {
  const peer = exchangeBroker();
  const session = await createTransportClient(peer.transport, { clientId: 'receiver', onQosTwoMessage() {} }).connect();
  expect(peer.connection(0).packets[0]).toMatchObject({ cmd: 'connect', receiveMaximum: 1 });
  await session.disconnect();
});

test.each([1, 2] as const)(
  'a QoS %i PUBLISH while a QoS 2 publication waits for PUBREL exceeds the Receive Maximum',
  async (qos) => {
    const { session, connection, delivered, ends } = await receiver();
    connection.deliver(publication(7));
    await settle();
    connection.deliver(publication(8, qos));
    await settle();
    expect(delivered).toEqual([7]);
    expect(answers(connection.frames)).toEqual([
      [0x50, 2, 0, 7],
      [0xe0, 1, 0x93],
    ]);
    expect(ends).toMatchObject([{ kind: 'error', error: { code: 'ERR_MQTT_PROTOCOL', reasonCode: 0x93 } }]);
    await expect(session.ping()).rejects.toMatchObject({ message: 'MQTT Receive Maximum exceeded' });
  },
);

test('PUBCOMP frees the receive slot, and one next PUBLISH may arrive while the PUBCOMP write is pending', async () => {
  const { session, connection, delivered, releaseWrites } = await receiver({
    hold: (packet) => packet.cmd === 'pubcomp' && packet.messageId === 7,
  });
  connection.deliver(publication(7));
  await settle();
  connection.deliver({ cmd: 'pubrel', messageId: 7, reasonCode: 0 });
  await settle();
  connection.deliver(publication(8));
  await settle();
  expect(delivered).toEqual([7]);
  releaseWrites();
  await settle();
  expect(delivered).toEqual([7, 8]);
  connection.deliver({ cmd: 'pubrel', messageId: 8, reasonCode: 0 });
  await settle();
  connection.deliver(publication(9, 1));
  await settle();
  expect(answers(connection.frames)).toEqual([
    [0x50, 2, 0, 7],
    [0x70, 2, 0, 7],
    [0x50, 2, 0, 8],
    [0x70, 2, 0, 8],
    [0x40, 2, 0, 9],
  ]);
  await session.disconnect();
});

test('a second PUBLISH while the PUBCOMP write is pending exceeds the Receive Maximum', async () => {
  const { session, connection, delivered } = await receiver({ hold: (packet) => packet.cmd === 'pubcomp' });
  connection.deliver(publication(7));
  await settle();
  connection.deliver({ cmd: 'pubrel', messageId: 7, reasonCode: 0 });
  await settle();
  connection.deliver(publication(8));
  connection.deliver(publication(9));
  await settle();
  expect(delivered).toEqual([7]);
  await expect(session.ping()).rejects.toMatchObject({ code: 'ERR_MQTT_PROTOCOL', reasonCode: 0x93 });
});

test.each([
  ['no QoS 2 handler', { onQosTwoMessage: undefined }],
  ['no QoS 1 handler', { onQosOneMessage: undefined }],
] as const)('a QoS 2 subscription with %s rejects before any write', async (_name, missing) => {
  const { session, connection } = await receiver({}, missing);
  await expect(session.subscribe('a', { qos: 2 })).rejects.toMatchObject({
    code: 'ERR_MQTT_INVALID_ARGUMENT',
    fatal: false,
    message: 'QoS 2 subscription requires onQosTwoMessage and onQosOneMessage',
  });
  expect(connection.frames).toEqual([]);
  await session.disconnect();
});

test.each([0, 1, 2] as const)('a QoS 2 subscription reports granted QoS %i', async (granted) => {
  const { session, connection } = await receiver({ suback: () => granted });
  await expect(session.subscribe('a', { qos: 2 })).resolves.toEqual({ grantedQos: granted, reasonCode: granted });
  expect(connection.packets[1]).toMatchObject({ cmd: 'subscribe', topics: ['a'], qos: 2 });
  expect(connection.frames[0]).toEqual([0x82, 7, 0, 1, 0, 0, 1, 0x61, 2]);
  await session.disconnect();
});

test('a QoS 2 subscription delivers each publication to the handler of its own QoS', async () => {
  const seen: string[] = [];
  const { session, connection } = await receiver(
    {},
    {
      onMessage(message: Readonly<{ qos: 0 }>) {
        seen.push('zero ' + String(message.qos));
      },
      onQosOneMessage(message: Readonly<{ qos: 1; messageId: number }>) {
        seen.push('one ' + String(message.messageId));
      },
      onQosTwoMessage(message: Readonly<{ qos: 2; messageId: number }>) {
        seen.push('two ' + String(message.messageId));
      },
    },
  );
  await session.subscribe('a', { qos: 2 });
  connection.deliver({ cmd: 'publish', topic: 'a', payload: utf8('hi') });
  connection.deliver(publication(3, 1));
  await settle();
  connection.deliver(publication(4));
  await settle();
  expect(seen).toEqual(['zero 0', 'one 3', 'two 4']);
  expect(answers(connection.frames)).toEqual([
    [0x40, 2, 0, 3],
    [0x50, 2, 0, 4],
  ]);
  await session.disconnect();
});

test('a QoS 1 PUBLISH ends a session that handles only QoS 2', async () => {
  const { session, connection, ends } = await receiver({}, { onQosOneMessage: undefined });
  connection.deliver(publication(3, 1));
  await settle();
  expect(ends).toMatchObject([{ kind: 'error', error: { message: 'Unsupported incoming MQTT PUBLISH' } }]);
  await expect(session.ping()).rejects.toThrow('Unsupported incoming MQTT PUBLISH');
});

test('disconnect() answers no PUBREL afterwards, and DISCONNECT is the last packet', async () => {
  const { session, connection } = await receiver();
  connection.deliver(publication(7));
  await settle();
  const closing = session.disconnect();
  connection.deliver({ cmd: 'pubrel', messageId: 7, reasonCode: 0 });
  connection.deliver({ cmd: 'pubrel', messageId: 9, reasonCode: 0 });
  await closing;
  connection.deliver({ cmd: 'pubrel', messageId: 7, reasonCode: 0 });
  await settle();
  expect(answers(connection.frames)).toEqual([
    [0x50, 2, 0, 7],
    [0xe0, 0],
  ]);
});

test('a handler that finishes after disconnect() sends no PUBREC', async () => {
  const handler = gate();
  const { session, connection } = await receiver(
    {},
    {
      async onQosTwoMessage() {
        await handler.promise;
      },
    },
  );
  connection.deliver(publication(7));
  await settle();
  const closing = session.disconnect();
  handler.release();
  await closing;
  await settle();
  expect(answers(connection.frames)).toEqual([[0xe0, 0]]);
});

test('a QoS 2 PUBLISH before CONNACK ends the connection attempt', async () => {
  const transport: ByteTransport = {
    name: 'Early broker',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- ByteTransport.open in src/byteTransport.ts takes the mutable ByteInbound and returns a promise, and promise-function-async requires an async function for that. This opener settles without waiting for anything.
    async open(inbound: ByteInbound) {
      return {
        bufferedBytes: 0,
        async write() {
          await Promise.resolve();
          inbound.bytes(Uint8Array.from(publishBytes(false)));
        },
        async close() {},
      };
    },
  };
  const connecting = createTransportClient(transport, { clientId: 'receiver', onQosTwoMessage() {} }).connect();
  await expect(connecting).rejects.toMatchObject({
    code: 'ERR_MQTT_PROTOCOL',
    message: 'Inbound QoS 2 PUBLISH arrived before CONNACK',
  });
});
