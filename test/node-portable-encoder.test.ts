import { once } from 'node:events';
import { createServer } from 'node:net';
import { generate, parser, type Packet } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { encodePacket } from '../src/codec.js';
import { createTcpClient } from '../src/tcpClient.js';
import { toWirePacket } from '../src/wirePacket.js';

const sessionPackets: [string, Packet][] = [
  [
    'CONNECT with credentials and Receive Maximum',
    {
      cmd: 'connect',
      protocolVersion: 5,
      protocolId: 'MQTT',
      clean: true,
      keepalive: 0,
      clientId: 'c',
      username: 'u',
      password: Buffer.from('p'),
      properties: { receiveMaximum: 1 },
    },
  ],
  ['SUBSCRIBE at QoS 1', { cmd: 'subscribe', messageId: 2, subscriptions: [{ topic: 'a/+', qos: 1 }] }],
  ['SUBSCRIBE to a shared filter', { cmd: 'subscribe', messageId: 3, subscriptions: [{ topic: '$share/group/a', qos: 0 }] }],
  ['UNSUBSCRIBE', { cmd: 'unsubscribe', messageId: 4, unsubscriptions: ['a/+'] }],
  ['QoS 0 PUBLISH', { cmd: 'publish', topic: 'a/b', payload: 'hé', qos: 0, dup: false, retain: false }],
  ['QoS 1 PUBLISH', { cmd: 'publish', topic: 'a/b', payload: 'x', qos: 1, messageId: 5, dup: false, retain: false }],
  ['PUBACK', { cmd: 'puback', messageId: 6, reasonCode: 0 }],
  ['PINGREQ', { cmd: 'pingreq' }],
  ['DISCONNECT', { cmd: 'disconnect' }],
  ['DISCONNECT with a protocol error', { cmd: 'disconnect', reasonCode: 0x82 }],
];

function comparable(packet: unknown): unknown {
  if (typeof packet !== 'object' || packet === null) throw new Error('Expected a parsed packet');
  const reasonCode: unknown = 'reasonCode' in packet ? packet.reasonCode : undefined;
  // mqtt-packet reports the encoded length and reads an omitted DISCONNECT reason as success.
  return { ...packet, length: undefined, properties: undefined, reasonCode: reasonCode ?? 0 };
}

function parse(bytes: readonly number[]): Packet[] {
  const packets: Packet[] = [];
  const decoder = parser({ protocolVersion: 5 });
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  decoder.on('packet', (packet) => {
    packets.push(packet);
  });
  decoder.parse(Buffer.from(bytes));
  return packets;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
test.each(sessionPackets)('mqtt-packet reads the portable encoding of %s as the same packet', (_name, packet) => {
  const portable = parse(Array.from(encodePacket(toWirePacket(packet), { sharedSubscriptions: true })));
  const reference = parse(Array.from(generate(packet, { protocolVersion: 5 })));
  expect(portable).toHaveLength(1);
  expect(comparable(portable[0])).toEqual(comparable(reference[0]));
});

test.each(['$share//a', '$share/g', '$share/g/', '$share/+/a', '$share/g#/a'])(
  'rejects the malformed shared filter %j',
  (filter) => {
    expect(() => encodePacket({ cmd: 'subscribe', messageId: 1, topics: [filter] }, { sharedSubscriptions: true })).toThrow(
      'Invalid MQTT shared subscription',
    );
  },
);

test('encodes a shared filter only when the caller allows shared subscriptions', () => {
  const packet = { cmd: 'subscribe', messageId: 1, topics: ['$share/g/a/+'] } as const;
  expect(() => encodePacket(packet)).toThrow('Unsupported shared subscription');
  expect(Array.from(encodePacket(packet, { sharedSubscriptions: true }))).toEqual([
    0x82, 18, 0, 1, 0, 0, 12, 0x24, 0x73, 0x68, 0x61, 0x72, 0x65, 0x2f, 0x67, 0x2f, 0x61, 0x2f, 0x2b, 0,
  ]);
});

test('rejects a session packet that a client never sends', () => {
  expect(() => toWirePacket({ cmd: 'pingresp' })).toThrow('Unsupported client operation');
  expect(() => toWirePacket({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: 'a', qos: 2 }] })).toThrow(
    'Unsupported subscription options',
  );
});

test('TCP client writes the portable encoding for a connect, subscribe, publish and disconnect exchange', async () => {
  const written: number[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const server = createServer((socket) => {
    const decoder = parser({ protocolVersion: 5 });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    socket.on('data', (chunk) => {
      if (typeof chunk === 'string') throw new Error('Expected bytes');
      written.push(...chunk);
      decoder.parse(chunk);
    });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    decoder.on('packet', (packet) => {
      if (packet.cmd === 'connect')
        socket.write(generate({ cmd: 'connack', sessionPresent: false, reasonCode: 0 }, { protocolVersion: 5 }));
      if (packet.cmd === 'subscribe')
        socket.write(generate({ cmd: 'suback', messageId: packet.messageId, granted: [0] }, { protocolVersion: 5 }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  try {
    const session = await createTcpClient({ host: '127.0.0.1', port: address.port, clientId: 'c' }).connect();
    await session.subscribe('a');
    await session.publish('a', 'x');
    await session.disconnect();
    await expect.poll(() => written.length).toBe(34);
    expect(written).toEqual([
      ...[0x10, 14, 0, 4, 0x4d, 0x51, 0x54, 0x54, 5, 2, 0, 0, 0, 0, 1, 0x63],
      ...[0x82, 7, 0, 1, 0, 0, 1, 0x61, 0],
      ...[0x30, 5, 0, 1, 0x61, 0, 0x78],
      ...[0xe0, 0],
    ]);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});
