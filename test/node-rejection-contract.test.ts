import { expect, test } from 'vitest';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';
import { ProtocolInputError } from '../src/protocolInputError.js';
import { MqttPacketCompactDecoder } from './experiments/mqtt-packet-compact-decoder.js';

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
    if (reason instanceof ProtocolInputError) return 'ProtocolInputError 0x' + reason.code.toString(16) + ' ' + reason.message;
    if (reason instanceof Error) return reason.constructor.name + ' ' + reason.message;
    throw reason;
  }
}

// Each row is broker input whose outcome changed when the Node adapters moved from mqtt-packet's parser to the
// portable codec. "before" is the retained mqtt-packet framer. "after" is the supported decoder.
const changes = [
  {
    name: 'a QoS 0 PUBLISH with DUP set',
    bytes: [0x38, 4, 0, 1, 0x61, 0],
    before: 'packet publish',
    after: 'ProtocolInputError 0x81 Invalid MQTT PUBLISH DUP flag for QoS 0',
  },
  {
    name: 'a SUBSCRIBE outside the client profile',
    bytes: [0x82, 7, 0, 1, 0, 0, 1, 0x61, 2],
    before: 'packet subscribe',
    after: 'ProtocolInputError 0x82 Unexpected MQTT packet from broker: SUBSCRIBE',
  },
  {
    name: 'a CONNECT with a Will flag',
    bytes: [0x10, 21, 0, 4, 0x4d, 0x51, 0x54, 0x54, 5, 0x06, 0, 0, 0, 0, 1, 0x63, 0, 0, 1, 0x74, 0, 1, 0x70],
    before: 'packet connect',
    after: 'ProtocolInputError 0x82 Unexpected MQTT packet from broker: CONNECT',
  },
  {
    name: 'a refused CONNACK with Session Present',
    bytes: [0x20, 3, 1, 0x87, 0],
    before: 'packet connack',
    after: 'Error Invalid CONNACK',
  },
  {
    name: 'a CONNACK with an undefined reason code',
    bytes: [0x20, 3, 0, 0x01, 0],
    before: 'packet connack',
    after: 'Error Invalid CONNACK',
  },
  {
    name: 'a PUBACK with packet identifier 0',
    bytes: [0x40, 0x2, 0x0, 0x0],
    before: 'packet puback',
    after: 'ProtocolInputError 0x82 MQTT integer out of range',
  },
  {
    name: 'a QoS 1 PUBLISH with packet identifier 0',
    bytes: [0x32, 0x6, 0x0, 0x1, 0x61, 0x0, 0x0, 0x0],
    before: 'packet publish',
    after: 'ProtocolInputError 0x82 MQTT integer out of range',
  },
  {
    name: 'a SUBACK with packet identifier 0',
    bytes: [0x90, 0x4, 0x0, 0x0, 0x0, 0x0],
    before: 'packet suback',
    after: 'ProtocolInputError 0x82 MQTT integer out of range',
  },
  {
    name: 'a UNSUBACK with packet identifier 0',
    bytes: [0xb0, 0x4, 0x0, 0x0, 0x0, 0x0],
    before: 'packet unsuback',
    after: 'ProtocolInputError 0x82 MQTT integer out of range',
  },
  {
    name: 'a PUBREC with packet identifier 0',
    bytes: [0x50, 0x2, 0x0, 0x0],
    before: 'packet pubrec',
    after: 'ProtocolInputError 0x82 MQTT integer out of range',
  },
  {
    name: 'a PUBREL with packet identifier 0',
    bytes: [0x62, 0x2, 0x0, 0x0],
    before: 'packet pubrel',
    after: 'ProtocolInputError 0x82 MQTT integer out of range',
  },
  {
    name: 'a PUBCOMP with packet identifier 0',
    bytes: [0x70, 0x2, 0x0, 0x0],
    before: 'packet pubcomp',
    after: 'ProtocolInputError 0x82 MQTT integer out of range',
  },
  {
    name: 'a SUBACK without reason codes',
    bytes: [0x90, 3, 0, 1, 0],
    before: 'packet suback',
    after: 'ProtocolInputError 0x81 Invalid SUBACK',
  },
  {
    name: 'an UNSUBACK without reason codes',
    bytes: [0xb0, 3, 0, 1, 0],
    before: 'packet unsuback',
    after: 'ProtocolInputError 0x81 Invalid UNSUBACK',
  },
  {
    name: 'an UNSUBACK with a reserved reason code',
    bytes: [0xb0, 4, 0, 1, 0, 3],
    before: 'ProtocolInputError 0x82 Invalid unsuback code',
    after: 'ProtocolInputError 0x82 Invalid UNSUBACK',
  },
  {
    name: 'a PINGRESP with a body',
    bytes: [0xd0, 1, 0],
    before: 'packet pingresp',
    after: 'Error Trailing MQTT bytes',
  },
  {
    name: 'an AUTH with an unparsable property',
    bytes: [0xf0, 3, 0x18, 1, 0],
    before: 'Error Cannot parse property code type',
    after: 'packet auth',
  },
  {
    name: 'a SUBACK with a reserved reason code',
    bytes: [0x90, 4, 0, 1, 0, 3],
    before: 'ProtocolInputError 0x82 Invalid suback code',
    after: 'ProtocolInputError 0x82 Invalid SUBACK',
  },
  {
    name: 'a PUBACK with a reserved reason code',
    bytes: [0x40, 4, 0, 1, 1, 0],
    before: 'Error Invalid puback reason code',
    after: 'Error Invalid PUBACK reason code',
  },
  {
    name: 'a PUBREC with a reserved reason code',
    bytes: [0x50, 4, 0, 1, 1, 0],
    before: 'Error Invalid pubrec reason code',
    after: 'Error Invalid PUBREC reason code',
  },
  {
    name: 'a PUBREL with a reserved reason code',
    bytes: [0x62, 4, 0, 1, 1, 0],
    before: 'Error Invalid pubrel reason code',
    after: 'Error Invalid PUBREL reason code',
  },
  {
    name: 'a DISCONNECT with a reserved reason code',
    bytes: [0xe0, 2, 1, 0],
    before: 'Error Invalid disconnect reason code',
    after: 'Error Invalid DISCONNECT reason code',
  },
  {
    name: 'an AUTH with a reserved reason code',
    bytes: [0xf0, 2, 1, 0],
    before: 'Error Invalid auth reason code',
    after: 'Error Invalid AUTH reason code',
  },
  {
    name: 'a QoS 2 PUBLISH with packet identifier 0',
    bytes: [0x34, 0x6, 0x0, 0x1, 0x61, 0x0, 0x0, 0x0],
    before: 'packet publish',
    after: 'ProtocolInputError 0x82 MQTT integer out of range',
  },
  {
    name: 'a PUBCOMP with a reserved reason code',
    bytes: [0x70, 0x4, 0x0, 0x1, 0x1, 0x0],
    before: 'Error Invalid pubcomp reason code',
    after: 'Error Invalid PUBCOMP reason code',
  },
  {
    name: 'a CONNACK with reserved flag bits',
    bytes: [0x20, 0x3, 0x2, 0x0, 0x0],
    before: 'Error Invalid connack flags, bits 7-1 must be set to 0',
    after: 'Error Invalid CONNACK',
  },
  {
    name: 'an AUTH without a reason code',
    bytes: [0xf0, 0x0],
    before: 'Error Invalid auth reason code',
    after: 'packet auth',
  },
  {
    name: 'a PUBACK with a truncated packet identifier',
    bytes: [0x40, 0x1, 0x0],
    before: 'packet puback',
    after: 'Error Truncated MQTT field',
  },
  {
    name: 'a five-byte Remaining Length',
    bytes: [0xd0, 0x80, 0x80, 0x80, 0x80],
    before: 'Error Invalid variable byte integer',
    after: 'Error Malformed MQTT Remaining Length',
  },
] as const;

// Since the codec reads each packet once, in wire order, the first defect in byte order wins. Before, the Node decoder
// checked every property before any other body field. Each row is a packet with two defects, or one cut short before
// its properties.
const orderChanges = [
  {
    name: 'a CONNACK with one body byte',
    bytes: [0x20, 0x1, 0x0],
    before: 'Error Truncated MQTT CONNACK property',
    after: 'Error Truncated MQTT field',
  },
  {
    name: 'a CONNACK without a body',
    bytes: [0x20, 0x0],
    before: 'Error Truncated MQTT CONNACK property',
    after: 'Error Truncated MQTT field',
  },
  {
    name: 'a QoS 1 PUBLISH cut inside its packet identifier',
    bytes: [0x32, 0x4, 0x0, 0x1, 0x61, 0x0],
    before: 'Error Truncated MQTT PUBLISH property',
    after: 'Error Truncated MQTT field',
  },
  {
    name: 'a CONNACK with reserved flag bits and an unknown property',
    bytes: [0x20, 0x5, 0x2, 0x0, 0x2, 0x7f, 0x0],
    before: 'Error Invalid MQTT CONNACK property identifier',
    after: 'Error Invalid CONNACK',
  },
  {
    name: 'a CONNACK with an undefined reason code and an unknown property',
    bytes: [0x20, 0x5, 0x0, 0x1, 0x2, 0x7f, 0x0],
    before: 'Error Invalid MQTT CONNACK property identifier',
    after: 'Error Invalid CONNACK',
  },
  {
    name: 'a PUBACK with a reserved reason code and an unknown property',
    bytes: [0x40, 0x6, 0x0, 0x1, 0x1, 0x2, 0x7f, 0x0],
    before: 'Error Invalid MQTT PUBACK property identifier',
    after: 'Error Invalid PUBACK reason code',
  },
  {
    name: 'a PUBREL with a reserved reason code and an unknown property',
    bytes: [0x62, 0x6, 0x0, 0x1, 0x1, 0x2, 0x7f, 0x0],
    before: 'Error Invalid MQTT PUBREL property identifier',
    after: 'Error Invalid PUBREL reason code',
  },
  {
    name: 'a DISCONNECT with a reserved reason code and an unknown property',
    bytes: [0xe0, 0x4, 0x1, 0x2, 0x7f, 0x0],
    before: 'Error Invalid MQTT DISCONNECT property identifier',
    after: 'Error Invalid DISCONNECT reason code',
  },
  {
    name: 'a PUBACK with packet identifier 0 and an unknown property',
    bytes: [0x40, 0x6, 0x0, 0x0, 0x0, 0x2, 0x7f, 0x0],
    before: 'Error Invalid MQTT PUBACK property identifier',
    after: 'ProtocolInputError 0x82 MQTT integer out of range',
  },
  {
    name: 'a SUBACK with packet identifier 0 and an unknown property',
    bytes: [0x90, 0x6, 0x0, 0x0, 0x2, 0x7f, 0x0, 0x0],
    before: 'Error Invalid MQTT SUBACK property identifier',
    after: 'ProtocolInputError 0x82 MQTT integer out of range',
  },
  {
    name: 'a QoS 1 PUBLISH with packet identifier 0 and an unknown property',
    bytes: [0x32, 0x8, 0x0, 0x1, 0x61, 0x0, 0x0, 0x2, 0x7f, 0x0],
    before: 'Error Invalid MQTT PUBLISH property identifier',
    after: 'ProtocolInputError 0x82 MQTT integer out of range',
  },
] as const;

test.each(orderChanges)('reports the first defect in wire order for $name', ({ bytes, before, after }) => {
  expect(outcome('before', bytes)).toBe(before);
  expect(outcome('after', bytes)).toBe(after);
});

// The order did not change where the properties come first on the wire, or where the topic was already checked first.
test.each([
  [
    'a SUBACK with a reserved reason code and an unknown property',
    [0x90, 0x6, 0x0, 0x1, 0x2, 0x7f, 0x0, 0x3],
    'Error Invalid MQTT SUBACK property identifier',
  ],
  [
    'a PUBLISH with ill-formed topic bytes and an unknown property',
    [0x30, 0x6, 0x0, 0x1, 0xc0, 0x2, 0x7f, 0x0],
    'Error Invalid MQTT PUBLISH topic UTF-8',
  ],
  [
    'a PUBLISH with an empty topic and an unknown property',
    [0x30, 0x5, 0x0, 0x0, 0x2, 0x7f, 0x0],
    'Error Invalid MQTT PUBLISH property identifier',
  ],
  [
    'a PUBLISH with Topic Alias 0',
    [0x30, 0x7, 0x0, 0x1, 0x61, 0x3, 0x23, 0x0, 0x0],
    'ProtocolInputError 0x94 Invalid MQTT Topic Alias',
  ],
] as const)('keeps the outcome for %s', (_name, bytes, result) => {
  expect(outcome('before', bytes)).toBe(result);
  expect(outcome('after', bytes)).toBe(result);
});

test.each(changes)('records the changed outcome for $name', ({ bytes, before, after }) => {
  expect(outcome('before', bytes)).toBe(before);
  expect(outcome('after', bytes)).toBe(after);
});

test.each([
  ['CONNECT', [0x10, 21, 0, 4, 0x4d, 0x51, 0x54, 0x54, 5, 0x06, 0, 0, 0, 0, 1, 0x63, 0, 0, 1, 0x74, 0, 1, 0x70]],
  ['PINGREQ', [0xc0, 0]],
  ['UNSUBSCRIBE', [0xa2, 6, 0, 1, 0, 0, 1, 0x61]],
  ['a shared SUBSCRIBE', [0x82, 15, 0, 1, 0, 0, 9, 0x24, 0x73, 0x68, 0x61, 0x72, 0x65, 0x2f, 0x67, 0x2f, 0x74, 0]],
] as const)('rejects a broker %s by its fixed header with the direction error', (_name, bytes) => {
  expect(outcome('after', bytes)).toMatch(/^ProtocolInputError 0x82 Unexpected MQTT packet from broker: /);
  expect(outcome('after', bytes.slice(0, 1))).toMatch(/^ProtocolInputError 0x82 Unexpected MQTT packet from broker: /);
});
