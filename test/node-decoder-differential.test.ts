import { generate, type Packet } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';
import { ProtocolInputError } from '../src/protocolInputError.js';
import { MqttPacketCompactDecoder } from './experiments/mqtt-packet-compact-decoder.js';

const userProperties = { region: 'eu', tag: ['a', 'b'] };
const pair = { k: 'v' };

// One valid broker packet of each kind that carries properties. Each stays under 128 bytes, so its Remaining Length is one byte.
const packets: Packet[] = [
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
      assignedClientIdentifier: 'as',
      topicAliasMaximum: 10,
      reasonString: 'ok',
      userProperties,
      wildcardSubscriptionAvailable: true,
      subscriptionIdentifiersAvailable: false,
      sharedSubscriptionAvailable: true,
      serverKeepAlive: 60,
      responseInformation: 're',
      serverReference: 'ot',
    },
  },
  {
    cmd: 'publish',
    topic: 'a/b',
    payload: Buffer.from('pay'),
    qos: 0,
    dup: false,
    retain: false,
    properties: {
      payloadFormatIndicator: true,
      messageExpiryInterval: 30,
      contentType: 't/p',
      responseTopic: 'r/1',
      correlationData: Buffer.from([1, 2]),
      subscriptionIdentifier: [1, 200],
      userProperties,
    },
  },
  {
    cmd: 'publish',
    topic: 'a',
    payload: Buffer.from('x'),
    qos: 1,
    messageId: 7,
    dup: false,
    retain: false,
    properties: { contentType: 'c', userProperties: pair },
  },
  { cmd: 'puback', messageId: 7, reasonCode: 0x10, properties: { reasonString: 'no', userProperties: pair } },
  { cmd: 'pubrec', messageId: 8, reasonCode: 0, properties: { reasonString: 'r' } },
  { cmd: 'suback', messageId: 9, granted: [0, 1], properties: { reasonString: 'pa', userProperties: pair } },
  { cmd: 'unsuback', messageId: 10, granted: [0, 17], properties: { reasonString: 'u' } },
  { cmd: 'disconnect', reasonCode: 0x8e, properties: { reasonString: 'ta', serverReference: 'o', userProperties: pair } },
];

function outcome(decoderKind: 'before' | 'after', bytes: readonly number[]): string {
  let delivered = 'nothing';
  try {
    const options = {
      onPacket(packet: Readonly<{ cmd: string }>) {
        delivered = 'packet ' + packet.cmd;
      },
    };
    const decoder = decoderKind === 'before' ? new MqttPacketCompactDecoder(options) : new NodePacketDecoder(options);
    decoder.push(Uint8Array.from(bytes));
    return delivered;
  } catch (reason) {
    if (reason instanceof ProtocolInputError)
      return 'ProtocolInputError 0x' + reason.reasonCode.toString(16) + ' ' + reason.message;
    if (reason instanceof Error) return reason.constructor.name + ' ' + reason.message;
    throw reason;
  }
}

/** Every one-byte substitution, deletion, zero-byte insertion and truncation of a packet body. */
function mutations(wire: readonly number[]): number[][] {
  const header = wire[0] ?? 0;
  const body = wire.slice(2);
  const frame = (bytes: readonly number[]) => [header, bytes.length, ...bytes];
  const mutated: number[][] = [];
  for (let index = 0; index < body.length; index++) {
    for (const value of [0x00, 0x01, 0x7f, 0x80, 0xc0, 0xff])
      if (value !== body[index]) mutated.push(frame([...body.slice(0, index), value, ...body.slice(index + 1)]));
    mutated.push(frame([...body.slice(0, index), ...body.slice(index + 1)]));
    mutated.push(frame([...body.slice(0, index), 0, ...body.slice(index)]));
    mutated.push(frame(body.slice(0, index)));
  }
  return mutated;
}

// The outcomes the codec reaches before or after the properties, in wire order, where the old decoder either checked
// the properties first or left the field to mqtt-packet and the session. docs/tcp-packet-input.md lists each kind.
const bodyFieldOutcome =
  /^(Error Truncated MQTT field|ProtocolInputError 0x82 MQTT integer out of range|Error Invalid CONNACK|Error Invalid [A-Z]+ reason code|ProtocolInputError 0x8[12] Invalid (SUBACK|UNSUBACK))$/u;

test('the single property reader matches the old Node validator on every mutated packet outside the documented body fields', () => {
  let total = 0;
  const changed: string[] = [];
  const unexpected: string[] = [];
  for (const packet of packets) {
    const wire = [...generate(packet, { protocolVersion: 5 })];
    expect(wire[1]).toBeLessThan(128);
    for (const bytes of mutations(wire)) {
      total++;
      const before = outcome('before', bytes);
      const after = outcome('after', bytes);
      if (before === after) continue;
      changed.push(before + ' => ' + after);
      // A changed outcome may only be a body-field rejection. It is never a delivered packet or another property error.
      if (!bodyFieldOutcome.test(after))
        unexpected.push(bytes.map((byte) => byte.toString(16)).join(' ') + ': ' + before + ' => ' + after);
    }
  }
  expect(unexpected).toEqual([]);
  // The sweep is deterministic. These counts change only when a decoder's outcomes change.
  expect({ total, changed: changed.length }).toEqual({ total: 2057, changed: 76 });
});
