import { generate } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { encodePacket, PacketDecoder, type WirePacket } from '../src/codec.js';

const publication = {
  cmd: 'publish',
  qos: 2,
  messageId: 258,
  topic: 'a',
  payload: Uint8Array.of(255),
  dup: false,
  retain: false,
} as const;

test('encodes and decodes fixed QoS 2 PUBLISH bytes at every fragment boundary', () => {
  const bytes = Uint8Array.of(0x34, 7, 0, 1, 97, 1, 2, 0, 255);
  expect(encodePacket(publication)).toEqual(bytes);
  expect(generate({ ...publication, payload: Buffer.of(255) }, { protocolVersion: 5 })).toEqual(Buffer.from(bytes));
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new PacketDecoder();
    const decoded = [...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))];
    expect(decoded).toEqual([publication]);
  }
});

test('preserves QoS 2 DUP, retain, maximum identifier, properties and empty payload', () => {
  const bytes = Uint8Array.of(0x3d, 10, 0, 1, 97, 255, 255, 4, 0x03, 0, 1, 120);
  const packet = { ...publication, dup: true, retain: true, messageId: 65_535, contentType: 'x', payload: new Uint8Array() };
  expect(encodePacket(packet)).toEqual(bytes);
  expect(new PacketDecoder().push(bytes)).toEqual([packet]);
});

test.each([
  ['pubrec', 0x50, 0x97],
  ['pubrel', 0x62, 0x92],
  ['pubcomp', 0x70, 0x92],
] as const)('accepts legal %s abbreviations and emits the shortest encoding', (cmd, header, reason) => {
  const acknowledgment = { cmd, messageId: 258, reasonCode: 0 } as const;
  expect(encodePacket(acknowledgment)).toEqual(Uint8Array.of(header, 2, 1, 2));
  expect(encodePacket({ ...acknowledgment, reasonCode: reason })).toEqual(Uint8Array.of(header, 3, 1, 2, reason));
  expect(generate({ ...acknowledgment, reasonCode: reason }, { protocolVersion: 5 }).subarray(0, 5)).toEqual(
    Buffer.of(header, 4, 1, 2, reason),
  );
  for (const bytes of [
    [header, 2, 1, 2],
    [header, 3, 1, 2, 0],
    [header, 4, 1, 2, 0, 0],
  ]) {
    expect(new PacketDecoder().push(Uint8Array.from(bytes))).toEqual([acknowledgment]);
  }
  expect(new PacketDecoder().push(Uint8Array.of(header, 3, 1, 2, reason))).toEqual([{ ...acknowledgment, reasonCode: reason }]);
});

test.each([
  ['pubrec', 0x50],
  ['pubrel', 0x62],
  ['pubcomp', 0x70],
] as const)('preserves a %s reason string and ordered repeated user properties', (cmd, header) => {
  const packet: WirePacket = {
    cmd,
    messageId: 258,
    reasonCode: 0,
    reasonString: 'r',
    userProperties: [
      ['k', 'a'],
      ['k', 'b'],
    ],
  };
  const bytes = Uint8Array.of(header, 22, 1, 2, 0, 18, 0x1f, 0, 1, 114, 0x26, 0, 1, 107, 0, 1, 97, 0x26, 0, 1, 107, 0, 1, 98);
  expect(new PacketDecoder().push(bytes)).toEqual([packet]);
  expect(encodePacket(packet)).toEqual(Uint8Array.of(header, 22, 1, 2, 0, 18, ...bytes.slice(10), ...bytes.slice(6, 10)));
});

test.each([
  { bytes: [0x36, 0], message: 'invalid fixed-header flags' },
  { bytes: [0x3e, 0], message: 'invalid fixed-header flags' },
  { bytes: [0x34, 6, 0, 1, 97, 0, 0, 0], message: 'MQTT integer out of range' },
  { bytes: [0x34, 4, 0, 1, 97, 1], message: 'Truncated MQTT field' },
  { bytes: [0x52, 0], message: 'invalid fixed-header flags' },
  { bytes: [0x60, 0], message: 'invalid fixed-header flags' },
  { bytes: [0x72, 0], message: 'invalid fixed-header flags' },
  { bytes: [0x50, 2, 0, 0], message: 'MQTT integer out of range' },
  { bytes: [0x62, 2, 0, 0], message: 'MQTT integer out of range' },
  { bytes: [0x70, 2, 0, 0], message: 'MQTT integer out of range' },
  { bytes: [0x50, 3, 0, 1, 0x92], message: 'Invalid PUBREC reason code' },
  { bytes: [0x62, 3, 0, 1, 0x80], message: 'Invalid PUBREL reason code' },
  { bytes: [0x70, 3, 0, 1, 0x10], message: 'Invalid PUBCOMP reason code' },
  { bytes: [0x50, 4, 0, 1, 0, 1], message: 'Invalid MQTT PUBREC property length' },
  { bytes: [0x62, 10, 0, 1, 0, 6, 0x1f, 0, 0, 0x1f, 0, 0], message: 'Duplicate MQTT PUBREL property' },
  { bytes: [0x70, 6, 0, 1, 0, 2, 0x01, 0], message: 'Invalid MQTT PUBCOMP property identifier' },
])(
  'rejects malformed QoS 2 bytes $bytes and poisons the decoder',
  ({ bytes, message }: Readonly<{ bytes: readonly number[]; message: string }>) => {
    const decoder = new PacketDecoder();
    expect(() => decoder.push(Uint8Array.from(bytes))).toThrow(message);
    expect(() => decoder.push(Uint8Array.of(0xd0, 0))).toThrow(message);
  },
);

test('rejects invalid QoS 2 identifiers, reason codes and encoder fields', () => {
  expect(() => encodePacket({ ...publication, messageId: 0 })).toThrow('MQTT integer out of range');
  expect(() => encodePacket({ cmd: 'pubrec', messageId: 0, reasonCode: 0 })).toThrow('MQTT integer out of range');
  expect(() => encodePacket({ cmd: 'pubrec', messageId: 1, reasonCode: 0x92 })).toThrow('Invalid PUBREC reason code');
  expect(() => encodePacket({ cmd: 'pubrel', messageId: 1, reasonCode: 0x80 })).toThrow('Invalid PUBREL reason code');
  expect(() => encodePacket({ cmd: 'pubcomp', messageId: 1, reasonCode: 0x10 })).toThrow('Invalid PUBCOMP reason code');
  expect(() => {
    Reflect.apply(encodePacket, undefined, [{ cmd: 'pubrel', messageId: 1, reasonCode: 0, dup: true }]);
  }).toThrow('Unsupported MQTT encoder field or packet');
  const topicAlias = { ...publication, topicAlias: 1 };
  expect(() => encodePacket(topicAlias)).toThrow('Unsupported MQTT encoder field or packet');
});

test('encodes and decodes a SUBSCRIBE that requests QoS 2', () => {
  const subscribe = Uint8Array.of(0x82, 7, 0, 1, 0, 0, 1, 97, 2);
  expect(encodePacket({ cmd: 'subscribe', messageId: 1, topics: ['a'], qos: 2 })).toEqual(subscribe);
  expect(new PacketDecoder().push(subscribe)).toEqual([{ cmd: 'subscribe', messageId: 1, topics: ['a'], qos: 2 }]);
  expect(generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: 'a', qos: 2 }] }, { protocolVersion: 5 })).toEqual(
    Buffer.from(subscribe),
  );
  expect(() => new PacketDecoder().push(Uint8Array.of(0x82, 7, 0, 1, 0, 0, 1, 97, 3))).toThrow('Unsupported subscription options');
});
