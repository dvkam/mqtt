import { once } from 'node:events';
import { generate, parser, type Packet } from 'mqtt-packet';
import { WebSocketServer } from 'ws';
import { expect, test, vi } from 'vitest';
import { createBrowserClient } from '../src/browserClient.js';
import { encodePacket, PacketDecoder, type WirePacket } from '../src/codec.js';
import { ProtocolInputError } from '../src/protocolInputError.js';
import type { SessionEnd } from '../src/session.js';

function decode(bytes: readonly number[]): WirePacket[] {
  return new PacketDecoder().push(Uint8Array.from(bytes));
}

const vectors: [string, WirePacket, number[]][] = [
  [
    'CONNACK broker limits',
    { cmd: 'connack', sessionPresent: false, reasonCode: 0, serverKeepAlive: 60, retainAvailable: false, maximumPacketSize: 1024 },
    [0x20, 13, 0, 0, 10, 0x13, 0, 60, 0x25, 0, 0x27, 0, 0, 4, 0],
  ],
  [
    'CONNACK capability flags and session expiry',
    {
      cmd: 'connack',
      sessionPresent: false,
      reasonCode: 0,
      sessionExpiryInterval: 3600,
      wildcardSubscriptionAvailable: true,
      subscriptionIdentifiersAvailable: false,
      sharedSubscriptionAvailable: true,
    },
    [0x20, 14, 0, 0, 11, 0x11, 0, 0, 0x0e, 0x10, 0x28, 1, 0x29, 0, 0x2a, 1],
  ],
  [
    'refused CONNACK with a server reference and reason string',
    { cmd: 'connack', sessionPresent: false, reasonCode: 0x9c, serverReference: 's', reasonString: 'x' },
    [0x20, 11, 0, 0x9c, 8, 0x1c, 0, 1, 0x73, 0x1f, 0, 1, 0x78],
  ],
  [
    'PUBLISH with every publisher property',
    {
      cmd: 'publish',
      topic: 't',
      payload: Uint8Array.of(0x70),
      retain: false,
      payloadFormatIndicator: 1,
      messageExpiryInterval: 5,
      contentType: 'a',
      responseTopic: 'r',
      correlationData: Uint8Array.of(1, 2),
      subscriptionIdentifiers: [1, 200],
    },
    [
      0x30, 30, 0, 1, 0x74, 25, 0x01, 1, 0x02, 0, 0, 0, 5, 0x03, 0, 1, 0x61, 0x08, 0, 1, 0x72, 0x09, 0, 2, 1, 2, 0x0b, 1, 0x0b,
      0xc8, 1, 0x70,
    ],
  ],
  [
    'DISCONNECT with a server reference and reason string',
    { cmd: 'disconnect', reasonCode: 0x8e, serverReference: 's', reasonString: 'x' },
    [0xe0, 10, 0x8e, 8, 0x1c, 0, 1, 0x73, 0x1f, 0, 1, 0x78],
  ],
];

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
test.each(vectors)('decodes and encodes the fixed vector for %s', (_name, packet, bytes) => {
  expect(decode(bytes)).toEqual([packet]);
  expect(Array.from(encodePacket(packet))).toEqual(bytes);
});

test.each([
  0x04, 0x80, 0x81, 0x82, 0x83, 0x87, 0x89, 0x8b, 0x8d, 0x8e, 0x8f, 0x90, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b,
  0x9c, 0x9d, 0x9e, 0x9f, 0xa0, 0xa1, 0xa2,
])('decodes DISCONNECT reason code %i', (reasonCode) => {
  expect(decode([0xe0, 1, reasonCode])).toEqual([{ cmd: 'disconnect', reasonCode }]);
});

test.each([
  ['an undefined DISCONNECT reason code', [0xe0, 1, 0x01], 'Invalid DISCONNECT reason code'],
  ['a publisher property in CONNACK', [0x20, 7, 0, 0, 4, 0x03, 0, 1, 0x61], 'Invalid MQTT CONNACK property 3'],
  ['a broker property in PUBLISH', [0x30, 7, 0, 1, 0x74, 3, 0x13, 0, 60], 'Invalid MQTT PUBLISH property 19'],
  ['a repeated Server Keep Alive', [0x20, 9, 0, 0, 6, 0x13, 0, 60, 0x13, 0, 60], 'Invalid MQTT CONNACK property 19'],
  ['a Retain Available value above one', [0x20, 5, 0, 0, 2, 0x25, 2], 'Invalid MQTT property value'],
  ['a zero Maximum Packet Size', [0x20, 8, 0, 0, 5, 0x27, 0, 0, 0, 0], 'MQTT integer out of range'],
  ['a zero Subscription Identifier', [0x30, 6, 0, 1, 0x74, 2, 0x0b, 0], 'MQTT integer out of range'],
  ['a Subscription Identifier in DISCONNECT', [0xe0, 4, 0, 2, 0x0b, 1], 'Invalid MQTT DISCONNECT property 11'],
  ['an unassigned property identifier', [0x20, 5, 0, 0, 2, 0x7f, 0], 'Unsupported MQTT property 127'],
] as const)('rejects %s', (_name, bytes, message) => {
  expect(() => decode(bytes)).toThrow(message);
});

test('rejects a Response Topic that contains a wildcard with reason 0x82', () => {
  let failure: unknown;
  try {
    decode([0x30, 9, 0, 1, 0x74, 4, 0x08, 0, 1, 0x2b, 0x70]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ProtocolInputError);
  expect(failure).toMatchObject({ message: 'Invalid MQTT Response Topic', code: 0x82 });
});

async function broker(connack: readonly number[]) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  server.on('connection', (socket) => {
    const decoder = parser({ protocolVersion: 5 });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    socket.on('message', (bytes) => {
      if (Buffer.isBuffer(bytes)) decoder.parse(bytes);
    });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    decoder.on('packet', (packet) => {
      if (packet.cmd === 'connect') socket.send(Buffer.from(connack));
      if (packet.cmd === 'pingreq') socket.send(generate({ cmd: 'pingresp' }, { protocolVersion: 5 }));
    });
  });
  return {
    url: 'ws://127.0.0.1:' + address.port,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    send(packet: Packet) {
      for (const socket of server.clients) socket.send(generate(packet, { protocolVersion: 5 }));
    },
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

const capabilities = Array.from(
  generate(
    {
      cmd: 'connack',
      sessionPresent: false,
      reasonCode: 0,
      properties: {
        sessionExpiryInterval: 0,
        receiveMaximum: 20,
        maximumQoS: 1,
        retainAvailable: true,
        maximumPacketSize: 1_048_576,
        topicAliasMaximum: 10,
        wildcardSubscriptionAvailable: true,
        subscriptionIdentifiersAvailable: true,
        sharedSubscriptionAvailable: true,
        serverKeepAlive: 60,
        responseInformation: 'reply',
        userProperties: { region: 'eu' },
      },
    },
    { protocolVersion: 5 },
  ),
);

test('browser client connects when CONNACK carries broker capabilities and keeps the session through a PUBLISH with properties', async () => {
  const peer = await broker(capabilities);
  const received = vi.fn<(packet: unknown) => void>();
  try {
    const session = await createBrowserClient({ url: peer.url, clientId: 'properties', onMessage: received }).connect();
    peer.send({
      cmd: 'publish',
      topic: 'reply/1',
      payload: Buffer.from('p'),
      qos: 0,
      dup: false,
      retain: false,
      properties: {
        payloadFormatIndicator: true,
        messageExpiryInterval: 30,
        contentType: 'text/plain',
        responseTopic: 'reply/2',
        correlationData: Buffer.from([1, 2]),
        subscriptionIdentifier: 7,
      },
    });
    await expect.poll(() => received.mock.calls.length).toBe(1);
    expect(received.mock.calls[0]?.[0]).toMatchObject({ topic: 'reply/1', payload: Uint8Array.of(0x70) });
    await session.ping();
    await session.disconnect();
  } finally {
    await peer.close();
  }
});

test('browser client reports a broker DISCONNECT that carries a reason string with its reason code', async () => {
  const peer = await broker(capabilities);
  const ended: SessionEnd[] = [];
  try {
    await createBrowserClient({
      url: peer.url,
      clientId: 'takeover',
      onSessionEnd: (event) => {
        ended.push(event);
      },
    }).connect();
    peer.send({ cmd: 'disconnect', reasonCode: 0x8e, properties: { reasonString: 'taken over' } });
    await expect.poll(() => ended.length).toBe(1);
    expect(ended[0]).toMatchObject({ kind: 'error', error: { message: 'MQTT broker disconnected', code: 0x8e } });
  } finally {
    await peer.close();
  }
});

test('browser client rejects a CONNACK that carries authentication properties', async () => {
  const peer = await broker(
    Array.from(
      generate(
        { cmd: 'connack', sessionPresent: false, reasonCode: 0, properties: { authenticationMethod: 'SCRAM-SHA-1' } },
        { protocolVersion: 5 },
      ),
    ),
  );
  try {
    await expect(createBrowserClient({ url: peer.url, clientId: 'auth' }).connect()).rejects.toThrow(
      'Unexpected MQTT authentication properties',
    );
  } finally {
    await peer.close();
  }
});
