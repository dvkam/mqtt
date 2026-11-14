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
    bytes: [0x40, 2, 0, 0],
    before: 'packet puback',
    after: 'RangeError MQTT integer out of range',
  },
  {
    name: 'a QoS 1 PUBLISH with packet identifier 0',
    bytes: [0x32, 6, 0, 1, 0x61, 0, 0, 0],
    before: 'packet publish',
    after: 'RangeError MQTT integer out of range',
  },
  {
    name: 'a SUBACK without reason codes',
    bytes: [0x90, 3, 0, 1, 0],
    before: 'packet suback',
    after: 'ProtocolInputError 0x81 Invalid SUBACK',
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
    name: 'a five-byte Remaining Length',
    bytes: [0xd0, 0x80, 0x80, 0x80, 0x80],
    before: 'Error Invalid variable byte integer',
    after: 'Error Malformed MQTT Remaining Length',
  },
] as const;

test.each(changes)('records the changed outcome for $name', ({ bytes, before, after }) => {
  expect(outcome('before', bytes)).toBe(before);
  expect(outcome('after', bytes)).toBe(after);
});

test.each([
  ['PINGREQ', [0xc0, 0]],
  ['UNSUBSCRIBE', [0xa2, 6, 0, 1, 0, 0, 1, 0x61]],
  ['a shared SUBSCRIBE', [0x82, 15, 0, 1, 0, 0, 9, 0x24, 0x73, 0x68, 0x61, 0x72, 0x65, 0x2f, 0x67, 0x2f, 0x74, 0]],
] as const)('rejects a broker %s by its fixed header with the direction error', (_name, bytes) => {
  expect(outcome('after', bytes)).toMatch(/^ProtocolInputError 0x82 Unexpected MQTT packet from broker: /);
});
