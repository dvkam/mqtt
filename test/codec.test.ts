import { generate, parser, type Packet } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { encodePacket, PacketDecoder, type WirePacket } from '../src/codec.js';

const vectors: [WirePacket, number[]][] = [
  [{ cmd: 'connect', clientId: 'c' }, [0x10, 14, 0, 4, 77, 81, 84, 84, 5, 2, 0, 0, 0, 0, 1, 99]],
  [{ cmd: 'connack', sessionPresent: false, reasonCode: 0 }, [0x20, 3, 0, 0, 0]],
  [{ cmd: 'publish', topic: 'a', payload: Uint8Array.of(255, 0) }, [0x30, 6, 0, 1, 97, 0, 255, 0]],
  [{ cmd: 'subscribe', messageId: 1, topics: ['a'] }, [0x82, 7, 0, 1, 0, 0, 1, 97, 0]],
  [{ cmd: 'suback', messageId: 1, granted: [0] }, [0x90, 4, 0, 1, 0, 0]],
  [{ cmd: 'pingreq' }, [0xc0, 0]],
  [{ cmd: 'pingresp' }, [0xd0, 0]],
  [{ cmd: 'disconnect' }, [0xe0, 0]],
];

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
test.each(vectors)('encodes independent MQTT 5 vector %j', (packet, bytes) => {
  expect(Array.from(encodePacket(packet))).toEqual(bytes);
});

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
test.each(vectors)('decodes every split of the independent vector %j', (packet, bytes) => {
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new PacketDecoder();
    const decoded = [...decoder.push(Uint8Array.from(bytes.slice(0, split))), ...decoder.push(Uint8Array.from(bytes.slice(split)))];
    expect(decoded).toHaveLength(1);
    expect(Array.from(encodePacket(requiredPacket(decoded[0])))).toEqual(bytes);
    expect(decoded[0]?.cmd).toBe(packet.cmd);
  }
});

test('preserves repeated ordered user properties including empty keys and values', () => {
  const bytes = Uint8Array.of(0x30, 17, 0, 1, 97, 13, 0x26, 0, 1, 107, 0, 0, 0x26, 0, 1, 107, 0, 1, 118);
  const packet: WirePacket = {
    cmd: 'publish',
    topic: 'a',
    payload: new Uint8Array(),
    userProperties: [
      ['k', ''],
      ['k', 'v'],
    ],
  };
  expect(encodePacket(packet)).toEqual(bytes);
  const decoded = new PacketDecoder().push(bytes)[0];
  expect(decoded).toMatchObject({
    userProperties: [
      ['k', ''],
      ['k', 'v'],
    ],
  });
  const empty: WirePacket = { ...packet, userProperties: [['', '']] };
  expect(new PacketDecoder().push(encodePacket(empty))[0]).toMatchObject({ userProperties: [['', '']] });
});

test('handles fragmented Remaining Length and coalesced frames without borrowing input memory', () => {
  const payload = new Uint8Array(160).fill(255);
  const large = encodePacket({ cmd: 'publish', topic: 'é', payload });
  const decoder = new PacketDecoder();
  const first = large.slice(0, 3);
  expect(decoder.push(first)).toEqual([]);
  first.fill(0);
  const rest = Uint8Array.from([...large.slice(3), 0xd0, 0]);
  const decoded = decoder.push(rest);
  rest.fill(0);
  expect(decoded).toMatchObject([{ cmd: 'publish', topic: 'é', payload }, { cmd: 'pingresp' }]);
});

test('rejects oversized declarations before a body arrives and stays failed', () => {
  const decoder = new PacketDecoder({ maxPacketBytes: 16 });
  expect(() => decoder.push(Uint8Array.of(0x30, 127))).toThrow('limit');
  expect(() => decoder.push(Uint8Array.of(0xd0, 0))).toThrow('limit');
});

test.each<[readonly number[], string]>([
  [[0xd1, 0], 'Unsupported MQTT packet or invalid fixed-header flags'],
  [[0xd0, 1, 0], 'Trailing MQTT bytes'],
  [[0xd0, 0x80, 0], 'Non-canonical MQTT variable integer'],
  [[0x30, 0xff, 0xff, 0xff, 0x80], 'Malformed MQTT Remaining Length'],
  [[0x30, 4, 0, 1, 0, 0], 'Invalid MQTT UTF-8 string'],
  [[0x30, 5, 0, 2, 0xc0, 0x80, 0], 'The encoded data was not valid for encoding utf-8'],
  [[0x30, 4, 0, 2, 97, 0], 'Invalid MQTT UTF-8 string'],
  [[0x30, 6, 0, 1, 97, 2, 0x26, 0], 'Truncated MQTT field'],
  [[0x20, 3, 2, 0, 0], 'Invalid CONNACK'],
  [[0x20, 3, 1, 0x80, 0], 'Invalid CONNACK'],
  [[0x90, 4, 0, 0, 0, 0], 'MQTT integer out of range'],
  [[0x90, 4, 0, 1, 0, 3], 'Invalid SUBACK'],
])('rejects malformed wire vector %j', (bytes, reason) => {
  expect(() => new PacketDecoder().push(Uint8Array.from(bytes))).toThrow(reason);
});

test('rejects duplicate or invalid singleton CONNACK properties', () => {
  expect(() => new PacketDecoder().push(Uint8Array.of(0x20, 9, 0, 0, 6, 0x21, 0, 1, 0x21, 0, 2))).toThrow(
    'Invalid Receive Maximum property',
  );
  expect(() => new PacketDecoder().push(Uint8Array.of(0x20, 6, 0, 0, 3, 0x21, 0, 0))).toThrow('MQTT integer out of range');
});

test.each(['a\u0000b', '\ud800'])('rejects strings that cannot be represented as MQTT UTF-8 %j', (clientId) => {
  expect(() => encodePacket({ cmd: 'connect', clientId })).toThrow('UTF-8');
});

test('rejects invalid identifiers, topics, budgets and unsupported packet profiles', () => {
  expect(() => encodePacket({ cmd: 'subscribe', messageId: 0, topics: ['a'] })).toThrow('MQTT integer out of range');
  expect(() => encodePacket({ cmd: 'publish', topic: 'a/#', payload: new Uint8Array() })).toThrow('Invalid MQTT topic');
  expect(() => new PacketDecoder({ maxPacketBytes: 0 })).toThrow('MQTT integer out of range');
  expect(() => new PacketDecoder().push(Uint8Array.of(0x32, 0))).toThrow('Unsupported');
  expect(() => new PacketDecoder().push(Uint8Array.of(0x20, 4, 0, 0, 1, 0x7f))).toThrow('Unsupported');
});

test('matches pinned mqtt-packet for the MQTT 5 preview operations', () => {
  for (const [packet, bytes] of vectors) {
    const decoded: Packet[] = [];
    const decoder = parser({ protocolVersion: 5 });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    decoder.on('packet', (value) => {
      decoded.push(value);
    });
    decoder.parse(Buffer.from(bytes));
    expect(decoded[0]?.cmd).toBe(packet.cmd);
    const upstream = generate(requiredPacket(decoded[0]), { protocolVersion: 5 });
    const expected = packet.cmd === 'disconnect' ? Buffer.from([0xe0, 2, 0, 0]) : Buffer.from(encodePacket(packet));
    expect(upstream).toEqual(expected);
  }
});

test('preserves UTF-8 supplementary characters and BOM characters', () => {
  const packet: WirePacket = { cmd: 'connect', clientId: '\ufeff😀', username: 'é', password: Uint8Array.of(0, 255) };
  expect(new PacketDecoder().push(encodePacket(packet))[0]).toMatchObject(packet);
});

test.each([
  [0xe0, 0],
  [0xe0, 1, 0],
  [0xe0, 2, 0, 0],
])('accepts the legal normal DISCONNECT abbreviation %j', (...bytes: readonly number[]) => {
  expect(new PacketDecoder().push(Uint8Array.from(bytes))).toEqual([{ cmd: 'disconnect' }]);
});

test('rejects unsupported encoder fields instead of silently changing protocol semantics', () => {
  const publish = { cmd: 'publish' as const, topic: 'a', payload: new Uint8Array(), qos: 1, messageId: 7 };
  const connect = { cmd: 'connect' as const, clientId: 'c', will: { topic: 'offline', payload: 'lost' } };
  const disconnect = { cmd: 'disconnect' as const, reasonCode: 0x80 };
  expect(() => encodePacket(publish)).toThrow('Unsupported');
  expect(() => encodePacket(connect)).toThrow('Unsupported');
  expect(() => encodePacket(disconnect)).toThrow('Unsupported');
});

test.each(['$share//a', '$share/g', '$share/g/', '$share/+/a', '$share/g/a'])(
  'rejects shared subscriptions outside the preview profile %j',
  (filter) => {
    expect(() => encodePacket({ cmd: 'subscribe', messageId: 1, topics: [filter] })).toThrow('Unsupported');
    const bytes = new TextEncoder().encode(filter);
    const wire = Uint8Array.of(0x82, 6 + bytes.length, 0, 1, 0, 0, bytes.length, ...bytes, 0);
    expect(() => new PacketDecoder().push(wire)).toThrow('Unsupported');
  },
);

function requiredPacket<PacketType>(packet: PacketType | undefined): PacketType {
  if (packet === undefined) throw new Error('Expected decoded packet');
  return packet;
}

test('decodes the explicit success DISCONNECT generated by mqtt-packet', () => {
  expect(new PacketDecoder().push(Uint8Array.of(0xe0, 2, 0, 0))).toEqual([{ cmd: 'disconnect' }]);
});
