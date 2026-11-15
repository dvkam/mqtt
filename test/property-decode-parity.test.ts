import { isUtf8 } from 'node:buffer';
import { generate, type Packet } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { PacketDecoder } from '../src/codec.js';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';
import { ProtocolInputError } from '../src/protocolInputError.js';
import { decodeUtf8 } from '../src/wireProperties.js';

function describeFailure(reason: unknown): string {
  if (reason instanceof ProtocolInputError) return 'ProtocolInputError 0x' + reason.code.toString(16) + ' ' + reason.message;
  if (reason instanceof Error) return reason.constructor.name + ' ' + reason.message;
  throw reason;
}

function nodeOutcome(bytes: readonly number[]): unknown {
  const packets: unknown[] = [];
  try {
    new NodePacketDecoder({
      onPacket(packet: unknown) {
        packets.push(packet);
      },
    }).push(Uint8Array.from(bytes));
    return packets;
  } catch (reason) {
    return describeFailure(reason);
  }
}

function browserOutcome(bytes: readonly number[]): unknown {
  try {
    return new PacketDecoder().push(Uint8Array.from(bytes));
  } catch (reason) {
    return describeFailure(reason);
  }
}

// One vector for each kind of property defect. Both decoders must report the same class, code and message.
const defects: [string, readonly number[], string][] = [
  [
    'ill-formed UTF-8 in a PUBLISH property',
    [0x30, 8, 0, 1, 0x61, 4, 0x03, 0, 1, 0xc0],
    'Error Invalid MQTT PUBLISH property UTF-8',
  ],
  ['U+0000 in a CONNACK property', [0x20, 7, 0, 0, 4, 0x1f, 0, 1, 0], 'Error Invalid MQTT CONNACK property UTF-8'],
  ['a PUBACK property cut short', [0x40, 6, 0, 1, 0, 2, 0x1f, 0], 'Error Truncated MQTT PUBACK property'],
  // The Content Type claims four bytes inside a three-byte property section. It must not borrow the payload.
  [
    'a PUBLISH property that runs into the payload',
    [0x30, 0x0b, 0, 1, 0x61, 3, 0x03, 0, 4, 0x61, 0x62, 0x63, 0x64],
    'Error Truncated MQTT PUBLISH property',
  ],
  [
    'a SUBACK property that runs into the reason codes',
    [0x90, 8, 0, 1, 3, 0x1f, 0, 2, 0x61, 0],
    'Error Truncated MQTT SUBACK property',
  ],
  ['an UNSUBACK without a Property Length', [0xb0, 2, 0, 1], 'Error Truncated MQTT UNSUBACK property'],
  ['a DISCONNECT Property Length past the packet', [0xe0, 2, 0, 127], 'Error Invalid MQTT DISCONNECT property length'],
  ['PUBACK bytes after the properties', [0x40, 5, 0, 1, 0, 0, 0], 'Error Invalid MQTT PUBACK property length'],
  ['an unassigned identifier', [0x20, 5, 0, 0, 2, 0x7f, 0], 'Error Invalid MQTT CONNACK property identifier'],
  ['a broker property in PUBLISH', [0x30, 7, 0, 1, 0x74, 3, 0x13, 0, 60], 'Error Invalid MQTT PUBLISH property identifier'],
  ['a Topic Alias in CONNACK', [0x20, 6, 0, 0, 3, 0x23, 0, 1], 'Error Invalid MQTT CONNACK property identifier'],
  ['a repeated Server Keep Alive', [0x20, 9, 0, 0, 6, 0x13, 0, 60, 0x13, 0, 60], 'Error Duplicate MQTT CONNACK property'],
  ['a repeated Reason String', [0x90, 10, 0, 1, 6, 0x1f, 0, 0, 0x1f, 0, 0, 0], 'Error Duplicate MQTT SUBACK property'],
  [
    'a repeated Topic Alias',
    [0x30, 10, 0, 1, 0x61, 6, 0x23, 0, 1, 0x23, 0, 1],
    'ProtocolInputError 0x82 Duplicate MQTT Topic Alias property',
  ],
  ['a non-canonical Property Length', [0x30, 5, 0, 1, 0x61, 0x80, 0], 'Error Non-canonical MQTT PUBLISH property integer'],
  ['an over-long Property Length', [0x30, 7, 0, 1, 0x61, 0x80, 0x80, 0x80, 0x80], 'Error Malformed MQTT PUBLISH property integer'],
  ['a Retain Available value above one', [0x20, 5, 0, 0, 2, 0x25, 2], 'Error Invalid MQTT property value'],
  ['a Maximum QoS above one', [0x20, 5, 0, 0, 2, 0x24, 2], 'Error Invalid MQTT property value'],
  ['a zero Receive Maximum', [0x20, 6, 0, 0, 3, 0x21, 0, 0], 'Error Invalid zero MQTT property value'],
  ['a zero Maximum Packet Size', [0x20, 8, 0, 0, 5, 0x27, 0, 0, 0, 0], 'Error Invalid zero MQTT property value'],
  ['a zero Subscription Identifier', [0x30, 6, 0, 1, 0x74, 2, 0x0b, 0], 'Error Invalid zero MQTT property value'],
  ['Topic Alias 0', [0x30, 7, 0, 1, 0x61, 3, 0x23, 0, 0], 'ProtocolInputError 0x94 Invalid MQTT Topic Alias'],
  ['a wildcard Response Topic', [0x30, 8, 0, 1, 0x61, 4, 0x08, 0, 1, 0x2b], 'ProtocolInputError 0x82 Invalid MQTT Response Topic'],
  ['an empty Response Topic', [0x30, 7, 0, 1, 0x61, 3, 0x08, 0, 0], 'ProtocolInputError 0x82 Invalid MQTT Response Topic'],
  ['ill-formed UTF-8 in a PUBLISH topic', [0x30, 4, 0, 1, 0xc0, 0], 'Error Invalid MQTT PUBLISH topic UTF-8'],
  ['U+0000 in a PUBLISH topic', [0x30, 4, 0, 1, 0, 0], 'Error Invalid MQTT PUBLISH topic UTF-8'],
  ['a PUBLISH topic cut short', [0x30, 3, 0, 5, 0x61], 'Error Truncated MQTT PUBLISH topic'],
];

test.each(defects)('Node and browser decoders reject %s the same way', (_name, bytes, outcome) => {
  expect(nodeOutcome(bytes)).toBe(outcome);
  expect(browserOutcome(bytes)).toBe(outcome);
});

function plainBytes(outcome: unknown): unknown {
  if (!Array.isArray(outcome)) return outcome;
  return outcome.map((packet: unknown) =>
    typeof packet === 'object' && packet !== null
      ? Object.fromEntries(
          Object.entries(packet).map((entry: Readonly<[string, unknown]>) => [
            entry[0],
            entry[1] instanceof Uint8Array ? [...entry[1]] : entry[1],
          ]),
        )
      : packet,
  );
}

const userProperties = { region: 'eu', tag: ['a', 'b'] };
const valid: [string, Packet][] = [
  [
    'a CONNACK with every broker property',
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
  [
    'a QoS 1 PUBLISH with every publisher property',
    {
      cmd: 'publish',
      topic: 'a/b',
      payload: Buffer.from('p'),
      qos: 1,
      messageId: 7,
      dup: false,
      retain: true,
      properties: {
        payloadFormatIndicator: true,
        messageExpiryInterval: 30,
        contentType: 'text/plain; charset=é',
        responseTopic: 'reply/1',
        correlationData: Buffer.from([1, 2]),
        subscriptionIdentifier: [1, 200],
        userProperties,
      },
    },
  ],
  [
    'a PUBACK with properties',
    { cmd: 'puback', messageId: 7, reasonCode: 0x10, properties: { reasonString: 'none', userProperties } },
  ],
  ['a SUBACK with a Reason String', { cmd: 'suback', messageId: 9, granted: [0, 1, 0x80], properties: { reasonString: 'partly' } }],
  [
    'a DISCONNECT with properties',
    { cmd: 'disconnect', reasonCode: 0x8e, properties: { reasonString: 'taken over', serverReference: 'other', userProperties } },
  ],
];

// Both decoders share one property reader, so this checks only that the two entry points agree. The decoded field
// values are pinned against literal packets in test/node-portable-parse.test.ts and test/portable-properties.test.ts.
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture rows hold mqtt-packet input objects with mutable Buffers.
test.each(valid)('Node and browser decoders produce the same packet for %s', (_name, packet) => {
  const bytes = Array.from(generate(packet, { protocolVersion: 5 }));
  const node = nodeOutcome(bytes);
  expect(node).toHaveLength(1);
  // Node byte fields are Buffer views and browser byte fields are Uint8Array views, so compare the bytes.
  expect(plainBytes(browserOutcome(bytes))).toStrictEqual(plainBytes(node));
});

const reference = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The MQTT UTF-8 string rule stated independently: well-formed UTF-8 and no U+0000. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The helper reads native byte views.
function referenceUtf8(bytes: Uint8Array): string | undefined {
  if (!isUtf8(bytes) || bytes.includes(0)) return undefined;
  return reference.decode(bytes);
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- A generator is consumed by iterating it, which advances its state.
function mismatches(sequences: Iterable<readonly number[]>): number[][] {
  const wrong: number[][] = [];
  for (const sequence of sequences) {
    const bytes = Uint8Array.from(sequence);
    if (decodeUtf8(bytes, 0, bytes.length) !== referenceUtf8(bytes)) wrong.push([...sequence]);
  }
  return wrong;
}

test('decodeUtf8 agrees with isUtf8 and a fatal TextDecoder for every one-byte and two-byte sequence', () => {
  function* sequences(): Generator<number[]> {
    for (let first = 0; first < 256; first++) {
      yield [first];
      for (let second = 0; second < 256; second++) yield [first, second];
    }
  }
  expect(mismatches(sequences())).toEqual([]);
});

test('decodeUtf8 agrees with the reference at the three-byte and four-byte boundaries', () => {
  const continuation = [0x00, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xff];
  function* sequences(): Generator<number[]> {
    for (let first = 0xe0; first <= 0xf7; first++)
      for (const second of continuation)
        for (const third of continuation) {
          yield [first, second, third];
          for (const fourth of continuation) yield [first, second, third, fourth];
        }
  }
  expect(mismatches(sequences())).toEqual([]);
});

test('decodeUtf8 agrees with the reference on both sides of its ASCII fast path limit', () => {
  const sequences: number[][] = [];
  for (const length of [0, 1, 63, 64, 65, 200]) {
    const ascii = Array.from({ length }, (_value, index) => 0x20 + (index % 90));
    sequences.push(ascii, [...ascii, 0], [0, ...ascii], [...ascii, 0xc3, 0xa9], [...ascii, 0xc3], [0xef, 0xbb, 0xbf, ...ascii]);
  }
  expect(mismatches(sequences)).toEqual([]);
});

test('decodeUtf8 reads only the given range', () => {
  const bytes = Uint8Array.of(0xff, 0x61, 0x62, 0x00);
  expect(decodeUtf8(bytes, 1, 3)).toBe('ab');
  expect(decodeUtf8(bytes, 1, 4)).toBeUndefined();
  expect(decodeUtf8(bytes, 0, 2)).toBeUndefined();
  expect(decodeUtf8(bytes, 2, 2)).toBe('');
});
