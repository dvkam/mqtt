import { expect, test } from 'vitest';
import { PacketDecoder } from '../src/codec.js';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';

const kinds = [
  'connect',
  'connack',
  'publish',
  'puback',
  'pubrec',
  'pubrel',
  'pubcomp',
  'subscribe',
  'suback',
  'unsubscribe',
  'unsuback',
  'disconnect',
] as const;
type Kind = (typeof kinds)[number];

const acknowledgments: readonly Kind[] = ['puback', 'pubrec', 'pubrel', 'pubcomp', 'suback', 'unsuback'];

// MQTT 5 table 2-4 (section 2.2.2.2), restricted to this client's profile: no Will, no AUTH, no enhanced
// authentication exchange, no Subscription Identifier in SUBSCRIBE, and no CONNECT property other than Receive Maximum.
// Each row is an identifier, one valid encoded value and the packets that may carry it. This table is written from the
// specification, not derived from the source.
const properties: readonly Readonly<{ identifier: number; value: readonly number[]; packets: readonly Kind[] }>[] = [
  { identifier: 0x01, value: [1], packets: ['publish'] },
  { identifier: 0x02, value: [0, 0, 0, 1], packets: ['publish'] },
  { identifier: 0x03, value: [0, 1, 0x61], packets: ['publish'] },
  { identifier: 0x08, value: [0, 1, 0x61], packets: ['publish'] },
  { identifier: 0x09, value: [0, 1, 1], packets: ['publish'] },
  { identifier: 0x0b, value: [1], packets: ['publish'] },
  { identifier: 0x11, value: [0, 0, 0, 1], packets: ['connack'] },
  { identifier: 0x12, value: [0, 1, 0x61], packets: ['connack'] },
  { identifier: 0x13, value: [0, 1], packets: ['connack'] },
  { identifier: 0x15, value: [0, 1, 0x61], packets: ['connack'] },
  { identifier: 0x16, value: [0, 1, 1], packets: ['connack'] },
  { identifier: 0x1a, value: [0, 1, 0x61], packets: ['connack'] },
  { identifier: 0x1c, value: [0, 1, 0x61], packets: ['connack', 'disconnect'] },
  { identifier: 0x1f, value: [0, 1, 0x61], packets: ['connack', 'disconnect', ...acknowledgments] },
  { identifier: 0x21, value: [0, 1], packets: ['connect', 'connack'] },
  { identifier: 0x22, value: [0, 1], packets: ['connack'] },
  { identifier: 0x23, value: [0, 1], packets: ['publish'] },
  { identifier: 0x24, value: [1], packets: ['connack'] },
  { identifier: 0x25, value: [1], packets: ['connack'] },
  { identifier: 0x26, value: [0, 1, 0x6b, 0, 1, 0x76], packets: kinds },
  { identifier: 0x27, value: [0, 0, 0, 1], packets: ['connack'] },
  { identifier: 0x28, value: [1], packets: ['connack'] },
  { identifier: 0x29, value: [1], packets: ['connack'] },
  { identifier: 0x2a, value: [1], packets: ['connack'] },
  // Assigned by MQTT 5 to packets outside this profile, or not assigned at all.
  { identifier: 0x00, value: [0], packets: [] },
  { identifier: 0x04, value: [0], packets: [] },
  { identifier: 0x17, value: [1], packets: [] },
  { identifier: 0x18, value: [0, 0, 0, 1], packets: [] },
  { identifier: 0x19, value: [1], packets: [] },
  { identifier: 0x2b, value: [0], packets: [] },
  { identifier: 0x7f, value: [0], packets: [] },
];

/** A minimal valid packet of `kind` whose property section holds `section`. */
function packet(kind: Kind, section: readonly number[]): number[] {
  const block = [section.length, ...section];
  const bodies: Readonly<Record<Kind, readonly [header: number, body: readonly number[]]>> = {
    connect: [0x10, [0, 4, 0x4d, 0x51, 0x54, 0x54, 5, 2, 0, 0, ...block, 0, 1, 0x61]],
    connack: [0x20, [0, 0, ...block]],
    publish: [0x30, [0, 1, 0x61, ...block]],
    puback: [0x40, [0, 1, 0, ...block]],
    pubrec: [0x50, [0, 1, 0, ...block]],
    pubrel: [0x62, [0, 1, 0, ...block]],
    pubcomp: [0x70, [0, 1, 0, ...block]],
    subscribe: [0x82, [0, 1, ...block, 0, 1, 0x61, 0]],
    suback: [0x90, [0, 1, ...block, 0]],
    unsubscribe: [0xa2, [0, 1, ...block, 0, 1, 0x61]],
    unsuback: [0xb0, [0, 1, ...block, 0]],
    disconnect: [0xe0, [0, ...block]],
  };
  const [header, body] = bodies[kind];
  return [header, body.length, ...body];
}

// The Node decoder rejects the client-only packets on the first byte, so the public decoder reads those three.
const clientOnly: readonly Kind[] = ['connect', 'subscribe', 'unsubscribe'];

function outcome(kind: Kind, bytes: readonly number[]): string {
  try {
    if (clientOnly.includes(kind)) return new PacketDecoder().push(Uint8Array.from(bytes)).length === 1 ? 'decoded' : 'nothing';
    let delivered = 'nothing';
    new NodePacketDecoder({
      onPacket() {
        delivered = 'decoded';
      },
    }).push(Uint8Array.from(bytes));
    return delivered;
  } catch (reason) {
    if (reason instanceof Error) return reason.message;
    throw reason;
  }
}

test('every packet decodes with an empty property section', () => {
  expect(kinds.map((kind) => outcome(kind, packet(kind, [])))).toEqual(kinds.map(() => 'decoded'));
});

test('each property identifier is accepted only in the packets MQTT 5 assigns it to', () => {
  const wrong: string[] = [];
  let pairs = 0;
  for (const { identifier, value, packets } of properties) {
    for (const kind of kinds) {
      pairs++;
      const expected = packets.includes(kind) ? 'decoded' : 'Invalid MQTT ' + kind.toUpperCase() + ' property identifier';
      const actual = outcome(kind, packet(kind, [identifier, ...value]));
      if (actual !== expected) wrong.push('0x' + identifier.toString(16) + ' in ' + kind + ': ' + actual);
    }
  }
  expect(wrong).toEqual([]);
  expect(pairs).toBe(31 * 12);
});
