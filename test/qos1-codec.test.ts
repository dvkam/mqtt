import { generate } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { encodePacket, PacketDecoder } from '../src/codec.js';

const publication = {
  cmd: 'publish',
  qos: 1,
  messageId: 258,
  topic: 'a',
  payload: Uint8Array.of(255),
  dup: false,
  retain: false,
} as const;
const acknowledgment = { cmd: 'puback', messageId: 258, reasonCode: 0 } as const;

test('encodes and decodes fixed QoS 1 PUBLISH bytes at every fragment boundary', () => {
  const bytes = Uint8Array.of(0x32, 7, 0, 1, 97, 1, 2, 0, 255);
  expect(encodePacket(publication)).toEqual(bytes);
  expect(generate({ ...publication, payload: Buffer.of(255) }, { protocolVersion: 5 })).toEqual(Buffer.from(bytes));
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new PacketDecoder();
    const decoded = [...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))];
    expect(decoded).toEqual([publication]);
  }
});

test('preserves QoS 1 DUP, retain, maximum identifier and empty payload', () => {
  const bytes = Uint8Array.of(0x3b, 6, 0, 1, 97, 255, 255, 0);
  const packet = { ...publication, dup: true, retain: true, messageId: 65_535, payload: new Uint8Array() };
  expect(encodePacket(packet)).toEqual(bytes);
  expect(new PacketDecoder().push(bytes)).toEqual([packet]);
});

test('accepts legal PUBACK abbreviations and emits the shortest encoding', () => {
  expect(encodePacket(acknowledgment)).toEqual(Uint8Array.of(0x40, 2, 1, 2));
  expect(encodePacket({ ...acknowledgment, reasonCode: 0x97 })).toEqual(Uint8Array.of(0x40, 3, 1, 2, 0x97));
  for (const bytes of [
    [0x40, 2, 1, 2],
    [0x40, 3, 1, 2, 0],
    [0x40, 4, 1, 2, 0, 0],
  ]) {
    expect(new PacketDecoder().push(Uint8Array.from(bytes))).toEqual([acknowledgment]);
  }
  expect(new PacketDecoder().push(Uint8Array.of(0x40, 3, 1, 2, 0x97))).toEqual([{ ...acknowledgment, reasonCode: 0x97 }]);
});

test('preserves a PUBACK reason string and ordered repeated user properties', () => {
  const packet = {
    ...acknowledgment,
    reasonCode: 0x10,
    reasonString: 'r',
    userProperties: [
      ['k', 'a'],
      ['k', 'b'],
    ],
  } as const;
  const bytes = Uint8Array.of(0x40, 22, 1, 2, 0x10, 18, 0x1f, 0, 1, 114, 0x26, 0, 1, 107, 0, 1, 97, 0x26, 0, 1, 107, 0, 1, 98);
  expect(new PacketDecoder().push(bytes)).toEqual([packet]);
  expect(encodePacket(packet)).toEqual(Uint8Array.of(0x40, 22, 1, 2, 0x10, 18, ...bytes.slice(10), ...bytes.slice(6, 10)));
});

test('preserves CONNACK Maximum QoS and rejects invalid or duplicate values', () => {
  for (const maximumQoS of [0, 1]) {
    const packet = { cmd: 'connack', sessionPresent: false, reasonCode: 0, receiveMaximum: 1, maximumQoS } as const;
    const bytes = Uint8Array.of(0x20, 8, 0, 0, 5, 0x21, 0, 1, 0x24, maximumQoS);
    expect(encodePacket(packet)).toEqual(bytes);
    expect(new PacketDecoder().push(bytes)).toEqual([packet]);
  }
  expect(() => new PacketDecoder().push(Uint8Array.of(0x20, 5, 0, 0, 2, 0x24, 2))).toThrow('MQTT integer out of range');
  expect(() => new PacketDecoder().push(Uint8Array.of(0x20, 7, 0, 0, 4, 0x24, 0, 0x24, 1))).toThrow('Invalid Maximum QoS property');
});

test.each([
  { bytes: [0x32, 6, 0, 1, 97, 0, 0, 0], message: 'MQTT integer out of range' },
  { bytes: [0x32, 4, 0, 1, 97, 1], message: 'Truncated MQTT field' },
  { bytes: [0x38, 0], message: 'invalid fixed-header flags' },
  { bytes: [0x34, 0], message: 'invalid fixed-header flags' },
  { bytes: [0x41, 0], message: 'invalid fixed-header flags' },
  { bytes: [0x40, 2, 0, 0], message: 'MQTT integer out of range' },
  { bytes: [0x40, 3, 0, 1, 0x81], message: 'Invalid PUBACK reason code' },
  { bytes: [0x40, 4, 0, 1, 0, 1], message: 'Truncated MQTT field' },
  { bytes: [0x40, 5, 0, 1, 0, 0, 0], message: 'Trailing MQTT bytes' },
  { bytes: [0x40, 10, 0, 1, 0, 6, 0x1f, 0, 0, 0x1f, 0, 0], message: 'Invalid Reason String property' },
])(
  'rejects malformed QoS 1 bytes $bytes and poisons the decoder',
  ({ bytes, message }: Readonly<{ bytes: readonly number[]; message: string }>) => {
    const decoder = new PacketDecoder();
    expect(() => decoder.push(Uint8Array.from(bytes))).toThrow(message);
    expect(() => decoder.push(Uint8Array.of(0xd0, 0))).toThrow(message);
  },
);

test('rejects invalid QoS, packet identifiers and unsupported encoder fields', () => {
  expect(() => encodePacket({ ...publication, messageId: 0 })).toThrow('MQTT integer out of range');
  expect(() => encodePacket({ ...acknowledgment, reasonCode: 0x81 })).toThrow('Invalid PUBACK reason code');
  expect(() => {
    Reflect.apply(encodePacket, undefined, [{ ...publication, qos: 2 }]);
  }).toThrow('MQTT integer out of range');
  for (const qos of [0, undefined]) {
    expect(() => {
      Reflect.apply(encodePacket, undefined, [{ ...publication, qos }]);
    }).toThrow('Unsupported QoS 0 PUBLISH field');
  }
  const topicAlias = { ...publication, topicAlias: 1 };
  expect(() => encodePacket(topicAlias)).toThrow('Unsupported MQTT encoder field or packet');
});
