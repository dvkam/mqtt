import { generate, parser, type Packet } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { encodePacket, PacketDecoder, type WirePacket } from '../src/codec.js';
import type { ReadonlyDeep } from '../src/util/bytes.js';

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

test.each(vectors)('encodes independent MQTT 5 vector %j', (packet: ReadonlyDeep<WirePacket>, bytes: readonly number[]) => {
  expect(Array.from(encodePacket(packet))).toEqual(bytes);
});

test.each(vectors)(
  'decodes every split of the independent vector %j',
  (packet: ReadonlyDeep<WirePacket>, bytes: readonly number[]) => {
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new PacketDecoder();
      const decoded = [
        ...decoder.push(Uint8Array.from(bytes.slice(0, split))),
        ...decoder.push(Uint8Array.from(bytes.slice(split))),
      ];
      expect(decoded).toHaveLength(1);
      expect(Array.from(encodePacket(requiredPacket(decoded[0])))).toEqual(bytes);
      expect(decoded[0]?.cmd).toBe(packet.cmd);
    }
  },
);

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
  [[0x30, 4, 0, 1, 0, 0], 'Invalid MQTT PUBLISH topic UTF-8'],
  [[0x30, 5, 0, 2, 0xc0, 0x80, 0], 'Invalid MQTT PUBLISH topic UTF-8'],
  [[0x30, 4, 0, 2, 97, 0], 'Invalid MQTT PUBLISH topic UTF-8'],
  [[0x30, 6, 0, 1, 97, 2, 0x26, 0], 'Truncated MQTT PUBLISH property'],
  [[0x20, 3, 2, 0, 0], 'Invalid CONNACK'],
  [[0x20, 3, 1, 0x80, 0], 'Invalid CONNACK'],
  [[0x90, 4, 0, 0, 0, 0], 'MQTT integer out of range'],
  [[0x90, 4, 0, 1, 0, 3], 'Invalid SUBACK'],
])('rejects malformed wire vector %j', (bytes, reason) => {
  expect(() => new PacketDecoder().push(Uint8Array.from(bytes))).toThrow(reason);
});

test('rejects duplicate or invalid singleton CONNACK properties', () => {
  expect(() => new PacketDecoder().push(Uint8Array.of(0x20, 9, 0, 0, 6, 0x21, 0, 1, 0x21, 0, 2))).toThrow(
    'Duplicate MQTT CONNACK property',
  );
  expect(() => new PacketDecoder().push(Uint8Array.of(0x20, 6, 0, 0, 3, 0x21, 0, 0))).toThrow('Invalid zero MQTT property value');
});

test.each(['a\u0000b', '\ud800'])('rejects strings that cannot be represented as MQTT UTF-8 %j', (clientId) => {
  expect(() => encodePacket({ cmd: 'connect', clientId })).toThrow('UTF-8');
});

test('rejects invalid identifiers, topics, budgets and unsupported packet profiles', () => {
  expect(() => encodePacket({ cmd: 'subscribe', messageId: 0, topics: ['a'] })).toThrow('MQTT integer out of range');
  expect(() => encodePacket({ cmd: 'publish', topic: 'a/#', payload: new Uint8Array() })).toThrow('Invalid MQTT topic');
  expect(() => new PacketDecoder({ maxPacketBytes: 0 })).toThrow('MQTT integer out of range');
  expect(() => new PacketDecoder().push(Uint8Array.of(0x34, 0))).toThrow('Unsupported');
  expect(() => new PacketDecoder().push(Uint8Array.of(0x20, 4, 0, 0, 1, 0x7f))).toThrow('Invalid MQTT CONNACK property identifier');
});

test('matches pinned mqtt-packet for the MQTT 5 preview operations', () => {
  for (const [packet, bytes] of vectors) {
    const decoded: Packet[] = [];
    const decoder = parser({ protocolVersion: 5 });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `value` is typed `Packet`. `Readonly<Packet>` still fails the rule, and with `ReadonlyDeep<Packet>` this code stops compiling (TS2345, Argument of type 'ReadonlyDeep<Packet>' is not assignable to parameter of type 'Packet'), so `value` would need a copy or a second hand-written type before it is passed on. `Packet` is declared in `mqtt-packet`.
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

test('encodes the CONNECT Will Flag and the empty Will property section', () => {
  const connect: WirePacket = {
    cmd: 'connect',
    clientId: 'c',
    will: { topic: 't', payload: Uint8Array.of(0x70) },
  };
  const bytes = Uint8Array.of(0x10, 21, 0, 4, 0x4d, 0x51, 0x54, 0x54, 5, 0x06, 0, 0, 0, 0, 1, 0x63, 0, 0, 1, 0x74, 0, 1, 0x70);
  expect(encodePacket(connect)).toEqual(bytes);
  expect(new PacketDecoder().push(bytes)).toEqual([
    {
      cmd: 'connect',
      clientId: 'c',
      cleanStart: true,
      keepAlive: 0,
      will: { topic: 't', payload: Uint8Array.of(0x70), qos: 0, retain: false },
    },
  ]);
});

test('encodes Will properties before the topic, payload, and credentials', () => {
  const will = {
    topic: 't',
    payload: Uint8Array.of(0, 255),
    qos: 1,
    retain: true,
    delayInterval: 3,
    messageExpiryInterval: 42,
    contentType: 'b',
    responseTopic: 'r',
    correlationData: Uint8Array.of(8),
    payloadFormatIndicator: 0,
    userProperties: [
      ['k', '1'],
      ['k', '2'],
    ],
  } as const;
  const packet: WirePacket = { cmd: 'connect', clientId: 'c', username: 'u', password: Uint8Array.of(0xaa), will };
  const properties = [
    0x26, 0, 1, 0x6b, 0, 1, 0x31, 0x26, 0, 1, 0x6b, 0, 1, 0x32, 0x18, 0, 0, 0, 3, 0x01, 0, 0x02, 0, 0, 0, 42, 0x03, 0, 1, 0x62,
    0x08, 0, 1, 0x72, 0x09, 0, 1, 8,
  ];
  const bytes = Uint8Array.of(
    0x10,
    66,
    0,
    4,
    0x4d,
    0x51,
    0x54,
    0x54,
    5,
    0xee,
    0,
    0,
    0,
    0,
    1,
    0x63,
    38,
    ...properties,
    0,
    1,
    0x74,
    0,
    2,
    0,
    0xff,
    0,
    1,
    0x75,
    0,
    1,
    0xaa,
  );
  expect(encodePacket(packet)).toEqual(bytes);
  expect(new PacketDecoder().push(bytes)).toMatchObject([packet]);
  const reference: Packet[] = [];
  const decoder = parser({ protocolVersion: 5 });
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `decoded` is typed `Packet`. `Readonly<Packet>` still fails the rule, and with `ReadonlyDeep<Packet>` this code stops compiling (TS2345, Argument of type 'ReadonlyDeep<Packet>' is not assignable to parameter of type 'Packet'), so `decoded` would need a copy or a second hand-written type before it is passed on. `Packet` is declared in `mqtt-packet`.
  decoder.on('packet', (decoded) => {
    reference.push(decoded);
  });
  decoder.parse(Buffer.from(bytes));
  expect(reference[0]).toMatchObject({
    cmd: 'connect',
    username: 'u',
    password: Buffer.from([0xaa]),
    will: {
      topic: 't',
      qos: 1,
      retain: true,
      payload: Buffer.from([0, 255]),
      properties: {
        willDelayInterval: 3,
        messageExpiryInterval: 42,
        contentType: 'b',
        responseTopic: 'r',
        correlationData: Buffer.from([8]),
        payloadFormatIndicator: false,
        userProperties: { k: ['1', '2'] },
      },
    },
  });
});

test.each([0x07, 0x0a, 0x22, 0x1e])('rejects invalid CONNECT Will flags %s', (flags) => {
  const bytes = Uint8Array.of(0x10, 21, 0, 4, 0x4d, 0x51, 0x54, 0x54, 5, flags, 0, 0, 0, 0, 1, 0x63, 0, 0, 1, 0x74, 0, 1, 0x70);
  expect(() => new PacketDecoder().push(bytes)).toThrow('Unsupported CONNECT flags');
});

test('a Will can request QoS 2 from the broker', () => {
  const will = { topic: 't', payload: Uint8Array.of(0x70), qos: 2 } as const;
  const wire = encodePacket({ cmd: 'connect', clientId: 'c', will });
  expect(wire[9]).toBe(0x16);
  expect(new PacketDecoder().push(wire)[0]).toMatchObject({ cmd: 'connect', will });
});

test('rejects invalid bytes flagged as a UTF-8 Will payload', () => {
  expect(() =>
    encodePacket({
      cmd: 'connect',
      clientId: 'c',
      will: { topic: 't', payload: Uint8Array.of(0xff), payloadFormatIndicator: 1 },
    }),
  ).toThrow('Invalid MQTT Will UTF-8 payload');
  const bytes = Uint8Array.of(
    0x10,
    23,
    0,
    4,
    0x4d,
    0x51,
    0x54,
    0x54,
    5,
    0x06,
    0,
    0,
    0,
    0,
    1,
    0x63,
    2,
    1,
    1,
    0,
    1,
    0x74,
    0,
    1,
    0xff,
  );
  expect(() => new PacketDecoder().push(bytes)).toThrow('Invalid MQTT Will UTF-8 payload');
});

test('reads the Will topic and byte payload once before validating the encoded values', () => {
  let topicReads = 0;
  let payloadReads = 0;
  const wire = encodePacket({
    cmd: 'connect',
    clientId: 'c',
    will: {
      get topic() {
        return ++topicReads === 1 ? 'status/a' : 'status/+';
      },
      get payload() {
        return Uint8Array.of(++payloadReads === 1 ? 0x61 : 0xff);
      },
      payloadFormatIndicator: 1,
    },
  });
  expect({ topicReads, payloadReads }).toEqual({ topicReads: 1, payloadReads: 1 });
  expect(new PacketDecoder().push(wire)[0]).toMatchObject({
    cmd: 'connect',
    will: { topic: 'status/a', payload: Uint8Array.of(0x61) },
  });
});

test.each([
  [0xe0, 0],
  [0xe0, 1, 0],
  [0xe0, 2, 0, 0],
])('accepts the legal normal DISCONNECT abbreviation %j', (...bytes: readonly number[]) => {
  expect(new PacketDecoder().push(Uint8Array.from(bytes))).toEqual([{ cmd: 'disconnect' }]);
});

test('rejects unsupported encoder fields instead of silently changing protocol semantics', () => {
  const publish = { cmd: 'publish' as const, topic: 'a', payload: new Uint8Array(), topicAlias: 7 };
  const connect = {
    cmd: 'connect' as const,
    clientId: 'c',
    will: { topic: 'offline', payload: Uint8Array.of(0), unknownField: 1 },
  };
  const disconnect = { cmd: 'disconnect' as const, sessionExpiryInterval: 5 };
  expect(() => encodePacket(publish)).toThrow('Unsupported');
  expect(() => encodePacket(connect)).toThrow('Unsupported');
  expect(() => encodePacket(disconnect)).toThrow('Unsupported');
  expect(() => encodePacket({ cmd: 'disconnect', reasonCode: 0x01 })).toThrow('Invalid DISCONNECT reason code');
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

test('finishes empty and complete input idempotently', () => {
  const empty = new PacketDecoder();
  expect(() => {
    empty.finish();
  }).not.toThrow();
  expect(() => {
    empty.finish();
  }).not.toThrow();
  expect(() => empty.push(new Uint8Array())).toThrow('ended');
  expect(() => empty.push(Uint8Array.of(0xd0, 0))).toThrow('ended');

  const decoder = new PacketDecoder();
  expect(decoder.push(Uint8Array.of(0xd0, 0, 0xe0, 0))).toEqual([{ cmd: 'pingresp' }, { cmd: 'disconnect' }]);
  expect(() => {
    decoder.finish();
  }).not.toThrow();
  expect(() => {
    decoder.finish();
  }).not.toThrow();
  expect(() => decoder.push(Uint8Array.of(0xd0, 0))).toThrow('ended');
});

test.each([[0x30], [0x30, 0x80], [0x20, 3], [0x20, 3, 0]])(
  'rejects truncated input and retains the same failure for %j',
  (...bytes: readonly number[]) => {
    const decoder = new PacketDecoder();
    expect(decoder.push(Uint8Array.from(bytes))).toEqual([]);
    const failure = captureFailure(() => {
      decoder.finish();
    });
    expect(failure.message).toMatch(/Truncated MQTT/);
    expect(
      captureFailure(() => {
        decoder.finish();
      }),
    ).toBe(failure);
    expect(captureFailure(() => decoder.push(Uint8Array.of(0xd0, 0)))).toBe(failure);
  },
);

test('keeps already returned packets when trailing input is truncated', () => {
  const decoder = new PacketDecoder();
  expect(decoder.push(Uint8Array.of(0xd0, 0, 0x30))).toEqual([{ cmd: 'pingresp' }]);
  expect(() => {
    decoder.finish();
  }).toThrow('Truncated MQTT');
});

test('finish preserves a previous decode failure', () => {
  const decoder = new PacketDecoder();
  const failure = captureFailure(() => decoder.push(Uint8Array.of(0xff)));
  expect(
    captureFailure(() => {
      decoder.finish();
    }),
  ).toBe(failure);
});

test('never emits a valid packet after successful completion', () => {
  const decoder = new PacketDecoder();
  decoder.finish();
  expect(() => decoder.push(Uint8Array.of(0xd0, 0))).toThrow('ended');
});

function captureFailure(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('Expected an Error failure');
  }
  throw new Error('Expected the operation to fail');
}

test.each([0x81, 0x82])('encodes and decodes subscription error DISCONNECT reason %i', (reasonCode) => {
  const bytes = Uint8Array.of(0xe0, 1, reasonCode);
  expect(encodePacket({ cmd: 'disconnect', reasonCode })).toEqual(bytes);
  expect(new PacketDecoder().push(bytes)).toEqual([{ cmd: 'disconnect', reasonCode }]);
});

test('reports the decoded prefix and keeps the first failure across later input', () => {
  const decoder = new PacketDecoder();
  const batch = decoder.pushBatch(Uint8Array.of(0xd0, 0, 0x90, 3, 0, 1, 0, 0xd0, 0));
  if (Array.isArray(batch)) throw new Error('Expected failed packet batch');
  expect(batch.packets).toEqual([{ cmd: 'pingresp' }]);
  expect(batch.error).toMatchObject({ message: 'Invalid SUBACK', reasonCode: 0x81 });
  expect(decoder.pushBatch(Uint8Array.of(0xd0, 0))).toEqual({ packets: [], error: batch.error });
  expect(captureFailure(() => decoder.push(Uint8Array.of(0xd0, 0)))).toBe(batch.error);
  expect(
    captureFailure(() => {
      decoder.finish();
    }),
  ).toBe(batch.error);
});

test.each([
  { payloadBytes: 123, prefix: [0x30, 0x7f, 0, 1, 97, 0] },
  { payloadBytes: 124, prefix: [0x30, 0x80, 1, 0, 1, 97, 0] },
  { payloadBytes: 16_380, prefix: [0x30, 0x80, 0x80, 1, 0, 1, 97, 0] },
])(
  'encodes an owned PUBLISH frame across the length boundary at $payloadBytes bytes',
  ({ payloadBytes, prefix }: Readonly<{ payloadBytes: number; prefix: readonly number[] }>) => {
    const backing = new Uint8Array(payloadBytes + 2).fill(0x6f);
    const payload = backing.subarray(1, payloadBytes + 1);
    payload.fill(0x5a);
    const frame = encodePacket({ cmd: 'publish', topic: 'a', payload });
    backing.fill(0);
    expect(frame.length).toBe(prefix.length + payloadBytes);
    expect(Array.from(frame.subarray(0, prefix.length))).toEqual(prefix);
    expect(frame.subarray(prefix.length)).toEqual(new Uint8Array(payloadBytes).fill(0x5a));
  },
);

test('writes the true byte length when the payload shadows its length property', () => {
  const payload = Uint8Array.of(0x5a);
  Object.defineProperty(payload, 'length', { value: 0 });
  expect(encodePacket({ cmd: 'publish', topic: 'a', payload })).toEqual(Uint8Array.of(0x30, 5, 0, 1, 97, 0, 0x5a));
});

test('sizes and copies the same PUBLISH payload when options use a getter', () => {
  let reads = 0;
  const frame = encodePacket({
    cmd: 'publish',
    topic: 'a',
    get payload() {
      reads++;
      return reads === 1 ? Uint8Array.of(0x5a) : Uint8Array.of(0x6f, 0x6f);
    },
  });
  expect(frame).toEqual(Uint8Array.of(0x30, 5, 0, 1, 97, 0, 0x5a));
  expect(reads).toBe(1);
});

test('reads each PUBLISH field once', () => {
  const reads = { topic: 0, qos: 0, dup: 0 };
  const frame = encodePacket({
    cmd: 'publish',
    payload: Uint8Array.of(0x5a),
    messageId: 7,
    get topic() {
      reads.topic++;
      return reads.topic === 1 ? 'ab' : 'a';
    },
    get qos(): 1 {
      reads.qos++;
      return 1;
    },
    get dup() {
      reads.dup++;
      return reads.dup === 1;
    },
  });
  expect(frame).toEqual(Uint8Array.of(0x3a, 8, 0, 2, 97, 98, 0, 7, 0, 0x5a));
  expect(reads).toEqual({ topic: 1, qos: 1, dup: 1 });
});

test('reads each User Property once and writes the value it checked', () => {
  const pair: [string, string] = ['k', 'ab'];
  let reads = 0;
  Object.defineProperty(pair, 1, { get: () => (++reads === 1 ? 'ab' : 'a\u0000') });
  const frame = encodePacket({ cmd: 'publish', topic: 'a', payload: Uint8Array.of(1), userProperties: [pair] });
  expect(frame).toEqual(Uint8Array.of(0x30, 13, 0, 1, 97, 8, 0x26, 0, 1, 107, 0, 2, 97, 98, 1));
  expect(reads).toBe(1);
});

test('never emits a frame with a stale length if a Subscription Identifier getter resizes the Correlation Data', () => {
  const { storage, resize } = resizableStorage(2);
  const identifiers = [1];
  Object.defineProperty(identifiers, 0, {
    get: () => {
      resize(1);
      return 1;
    },
  });
  expect(() =>
    encodePacket({
      cmd: 'publish',
      topic: 'a',
      payload: Uint8Array.of(1),
      correlationData: new Uint8Array(storage),
      subscriptionIdentifiers: identifiers,
    }),
  ).toThrow(new RangeError('MQTT bytes changed during encoding'));
});

test('encodes User Properties and Subscription Identifiers passed as a Set by a JavaScript caller', () => {
  const packet: Record<string, unknown> = {
    cmd: 'publish',
    topic: 'a',
    payload: Uint8Array.of(1),
    userProperties: new Set([['k', 'v']]),
    subscriptionIdentifiers: new Set([3]),
  };
  expect(Reflect.apply(encodePacket, undefined, [packet])).toEqual(
    Uint8Array.of(0x30, 14, 0, 1, 97, 9, 0x26, 0, 1, 107, 0, 1, 118, 0x0b, 3, 1),
  );
});

test('treats a null User Property list from a JavaScript caller as empty', () => {
  const packet: Record<string, unknown> = { cmd: 'publish', topic: 'a', payload: Uint8Array.of(1), userProperties: null };
  expect(Reflect.apply(encodePacket, undefined, [packet])).toEqual(Uint8Array.of(0x30, 5, 0, 1, 97, 0, 1));
});

test.each([
  ['a string', (): unknown => 'abc'],
  ['a DataView', (): unknown => new DataView(new ArrayBuffer(2))],
  ['a Uint16Array', (): unknown => Uint16Array.of(1)],
])('rejects %s as a PUBLISH payload', (_name, make) => {
  // The test passes a value the types exclude, as a JavaScript caller could.
  const packet: Record<string, unknown> = { cmd: 'publish', topic: 'a', payload: make() };
  expect(() => {
    Reflect.apply(encodePacket, undefined, [packet]);
  }).toThrow(new RangeError('Invalid MQTT binary data'));
});

function resizableStorage(length: number) {
  const storage: unknown = Reflect.construct(ArrayBuffer, [length, { maxByteLength: 2 }]);
  if (!(storage instanceof ArrayBuffer)) throw new Error('Expected resizable storage');
  const resize: unknown = Reflect.get(storage, 'resize');
  if (typeof resize !== 'function') throw new Error('Expected resize');
  return {
    storage,
    resize: (to: number): void => {
      Reflect.apply(resize, storage, [to]);
    },
  };
}

test('sizes a PUBLISH payload by its own length, not a subclass getter', () => {
  const { storage, resize } = resizableStorage(1);
  class GrowingPayload extends Uint8Array {
    override get byteLength(): number {
      resize(2);
      return 2;
    }
  }
  expect(encodePacket({ cmd: 'publish', topic: 'a', payload: new GrowingPayload(storage) })).toEqual(
    Uint8Array.of(0x30, 5, 0, 1, 97, 0, 0),
  );
  expect(storage.byteLength).toBe(1);
});
