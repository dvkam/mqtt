import { readFileSync } from 'node:fs';
import { generate, type Packet } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { NodePacketDecoder } from './experiments/session-packet-decoder.js';
import { MqttPacketCompactDecoder } from './experiments/mqtt-packet-compact-decoder.js';

const userProperties = { region: 'eu', tag: ['a', 'b'] };

const brokerPackets: [string, Packet][] = [
  [
    'CONNACK with every broker property',
    {
      cmd: 'connack',
      sessionPresent: false,
      reasonCode: 0,
      properties: {
        sessionExpiryInterval: 3600,
        receiveMaximum: 20,
        maximumQoS: 1,
        retainAvailable: false,
        maximumPacketSize: 4096,
        assignedClientIdentifier: 'assigned',
        topicAliasMaximum: 10,
        reasonString: 'ok',
        userProperties,
        wildcardSubscriptionAvailable: true,
        subscriptionIdentifiersAvailable: false,
        sharedSubscriptionAvailable: true,
        serverKeepAlive: 60,
        responseInformation: 'reply',
        serverReference: 'other',
      },
    },
  ],
  ['refused CONNACK', { cmd: 'connack', sessionPresent: false, reasonCode: 0x87 }],
  ['QoS 0 PUBLISH', { cmd: 'publish', topic: 'a/b', payload: Buffer.from([0, 255]), qos: 0, dup: false, retain: true }],
  [
    'QoS 1 PUBLISH with every publisher property',
    {
      cmd: 'publish',
      topic: 'a/b',
      payload: Buffer.from('p'),
      qos: 1,
      messageId: 7,
      dup: true,
      retain: false,
      properties: {
        payloadFormatIndicator: true,
        messageExpiryInterval: 30,
        contentType: 'text/plain',
        responseTopic: 'reply/1',
        correlationData: Buffer.from([1, 2]),
        subscriptionIdentifier: [1, 200],
        userProperties,
      },
    },
  ],
  [
    'QoS 0 PUBLISH with a Topic Alias and one Subscription Identifier',
    {
      cmd: 'publish',
      topic: 'a',
      payload: Buffer.alloc(0),
      qos: 0,
      dup: false,
      retain: false,
      properties: { topicAlias: 3, subscriptionIdentifier: 9 },
    },
  ],
  ['QoS 2 PUBLISH', { cmd: 'publish', topic: 'a', payload: Buffer.from('x'), qos: 2, messageId: 8, dup: false, retain: false }],
  ['PUBACK', { cmd: 'puback', messageId: 7, reasonCode: 0 }],
  [
    'PUBACK with a reason and properties',
    { cmd: 'puback', messageId: 7, reasonCode: 0x10, properties: { reasonString: 'none', userProperties } },
  ],
  ['PUBREC with a reason string', { cmd: 'pubrec', messageId: 8, reasonCode: 0, properties: { reasonString: 'r' } }],
  ['PUBREL', { cmd: 'pubrel', messageId: 8, reasonCode: 0 }],
  ['PUBCOMP', { cmd: 'pubcomp', messageId: 8, reasonCode: 0 }],
  ['SUBACK', { cmd: 'suback', messageId: 9, granted: [0, 1, 0x80], properties: { reasonString: 'partly' } }],
  ['UNSUBACK', { cmd: 'unsuback', messageId: 10, granted: [0, 17] }],
  ['PINGRESP', { cmd: 'pingresp' }],
  ['DISCONNECT', { cmd: 'disconnect', reasonCode: 0 }],
  [
    'DISCONNECT with properties',
    { cmd: 'disconnect', reasonCode: 0x8e, properties: { reasonString: 'taken over', serverReference: 'other', userProperties } },
  ],
  ['AUTH', { cmd: 'auth', reasonCode: 0 }],
];

const publishOnly = ['retain', 'qos', 'dup', 'topic', 'payload'];

function comparable(packet: unknown): unknown {
  if (typeof packet !== 'object' || packet === null || !('cmd' in packet)) throw new Error('Expected a decoded packet');
  if (packet.cmd === 'publish') return packet;
  // mqtt-packet's Packet object carries unset publish fields on every packet type.
  return Object.fromEntries(Object.entries(packet).filter((entry: Readonly<[string, unknown]>) => !publishOnly.includes(entry[0])));
}

function decodeWith(kind: 'portable' | 'reference', bytes: readonly number[], split: number) {
  const packets: unknown[] = [];
  const options = {
    onPacket: (packet: unknown) => {
      packets.push(comparable(packet));
    },
  };
  const decoder = kind === 'portable' ? new NodePacketDecoder(options) : new MqttPacketCompactDecoder(options);
  decoder.push(Uint8Array.from(bytes.slice(0, split)));
  decoder.push(Uint8Array.from(bytes.slice(split)));
  decoder.finish();
  return packets;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
test.each(brokerPackets)('decodes %s to the packet mqtt-packet produced, at every split', (_name, packet) => {
  const bytes = Array.from(generate(packet, { protocolVersion: 5 }));
  const reference = decodeWith('reference', bytes, 0);
  expect(reference).toHaveLength(1);
  for (let split = 0; split <= bytes.length; split++) expect(decodeWith('portable', bytes, split)).toEqual(reference);
});

test('delivers a PUBLISH payload as a Buffer view of the packet allocation', () => {
  const payloads: unknown[] = [];
  const decoder = new NodePacketDecoder({
    onPacket: (packet: unknown) => {
      if (typeof packet === 'object' && packet !== null && 'payload' in packet) payloads.push(packet.payload);
    },
  });
  decoder.push(Uint8Array.of(0x30, 5, 0, 1, 0x61, 0, 0x78));
  expect(payloads).toHaveLength(1);
  expect(Buffer.isBuffer(payloads[0])).toBe(true);
  expect(payloads[0]).toEqual(Buffer.from('x'));
});

test.each([
  ['a reserved packet type', [0x00, 0], 'Not supported'],
  ['CONNACK header flags', [0x21], 'Invalid header flag bits, must be 0x0 for connack packet'],
  ['PUBREL header flags', [0x60], 'Invalid header flag bits, must be 0x2 for pubrel packet'],
  ['both PUBLISH QoS bits', [0x36], 'Packet must not have both QoS bits set to 1'],
  ['a five-byte Remaining Length', [0xd0, 0x80, 0x80, 0x80, 0x80], 'Malformed MQTT Remaining Length'],
] as const)('rejects %s', (_name, bytes, message) => {
  const decoder = new NodePacketDecoder({ onPacket() {} });
  expect(() => {
    decoder.push(Uint8Array.from(bytes));
  }).toThrow(message);
});

test.each([
  'tcpClient',
  'websocketClient',
  'nodePacketDecoder',
  'nodePacketInput',
  'nodePacketListener',
  'sessionPacket',
  'wirePacket',
  'portable',
])('src/%s.ts takes only types from mqtt-packet', (name) => {
  const source = readFileSync(new URL('../src/' + name + '.ts', import.meta.url), 'utf8');
  const imports = source.split('\n').filter((line) => line.includes("from 'mqtt-packet'"));
  expect(imports.filter((line) => !line.startsWith('import type '))).toEqual([]);
});
