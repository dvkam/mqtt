import { expect, test, vi } from 'vitest';
import type { FramedPacket } from '../src/wireCodec.js';
import { NodePacketInput } from '../src/nodePacketInput.js';
import { nodePacketListener } from '../src/nodePacketListener.js';

const publication: FramedPacket = { cmd: 'publish', topic: 'typed/message', payload: Buffer.from([0, 255]), retain: false };

function listener(receiveQosOne = false, receiveQosTwo = false) {
  const received: unknown[] = [];
  const listen = nodePacketListener(
    (packet: unknown) => {
      received.push(packet);
    },
    receiveQosOne,
    receiveQosTwo,
  );
  return { received, listen };
}

test('delivers a QoS 0 PUBLISH as a flat message with only the fields the broker sent', () => {
  const { received, listen } = listener();
  listen(publication);
  expect(received).toStrictEqual([
    { cmd: 'publish', topic: 'typed/message', payload: Buffer.from([0, 255]), qos: 0, dup: false, retain: false },
  ]);
});

test('delivers every PUBLISH property flat, with User Properties in wire order', () => {
  const { received, listen } = listener();
  listen({
    ...publication,
    retain: true,
    payloadFormatIndicator: 1,
    messageExpiryInterval: 30,
    contentType: 'text/plain',
    responseTopic: 'reply/1',
    correlationData: Uint8Array.of(1, 2),
    subscriptionIdentifiers: [1, 200],
    userProperties: [
      ['a', '1'],
      ['b', '2'],
      ['a', '3'],
    ],
  });
  expect(received).toStrictEqual([
    {
      cmd: 'publish',
      topic: 'typed/message',
      payload: Buffer.from([0, 255]),
      qos: 0,
      dup: false,
      retain: true,
      payloadFormatIndicator: 1,
      messageExpiryInterval: 30,
      contentType: 'text/plain',
      responseTopic: 'reply/1',
      correlationData: Buffer.from([1, 2]),
      subscriptionIdentifiers: [1, 200],
      userProperties: [
        ['a', '1'],
        ['b', '2'],
        ['a', '3'],
      ],
    },
  ]);
});

test('delivers a QoS 1 PUBLISH with its identifier and DUP flag when the session receives QoS 1', () => {
  const { received, listen } = listener(true);
  listen({ ...publication, qos: 1, messageId: 9, dup: true, contentType: 'c' });
  expect(received).toStrictEqual([
    {
      cmd: 'publish',
      topic: 'typed/message',
      payload: Buffer.from([0, 255]),
      qos: 1,
      dup: true,
      retain: false,
      messageId: 9,
      contentType: 'c',
    },
  ]);
});

test('drops QoS 1 and QoS 2 PUBLISH when the session receives only QoS 0', () => {
  const { received, listen } = listener();
  listen({ ...publication, qos: 1, messageId: 1 });
  listen({ ...publication, qos: 2, messageId: 2 });
  expect(received).toEqual([]);
});

test('rejects a QoS 2 PUBLISH when the session receives QoS 1 only', () => {
  const { received, listen } = listener(true);
  expect(() => {
    listen({ ...publication, qos: 2, messageId: 2 });
  }).toThrow('Unsupported incoming MQTT PUBLISH');
  expect(received).toEqual([]);
});

test('delivers a QoS 2 PUBLISH with its identifier and DUP flag when the session receives QoS 2', () => {
  const { received, listen } = listener(false, true);
  listen({ ...publication, qos: 2, messageId: 9, dup: true });
  listen({ ...publication, qos: 2, messageId: 10 });
  expect(received).toStrictEqual([
    { cmd: 'publish', topic: 'typed/message', payload: Buffer.from([0, 255]), qos: 2, dup: true, retain: false, messageId: 9 },
    { cmd: 'publish', topic: 'typed/message', payload: Buffer.from([0, 255]), qos: 2, dup: false, retain: false, messageId: 10 },
  ]);
});

test('rejects a QoS 1 PUBLISH when the session receives QoS 2 only', () => {
  const { received, listen } = listener(false, true);
  expect(() => {
    listen({ ...publication, qos: 1, messageId: 2 });
  }).toThrow('Unsupported incoming MQTT PUBLISH');
  expect(received).toEqual([]);
});

test('forwards the public broker packets unchanged', () => {
  const { received, listen } = listener();
  const pingresp = { cmd: 'pingresp' } as const;
  const puback = { cmd: 'puback', messageId: 7, reasonCode: 0x10, reasonString: 'none', userProperties: [['k', 'v']] } as const;
  listen(pingresp);
  listen(puback);
  expect(received).toHaveLength(2);
  expect(received[0]).toBe(pingresp);
  expect(received[1]).toBe(puback);
});

test('forwards PUBREC, PUBREL and PUBCOMP to the session', () => {
  const { received, listen } = listener();
  const packets: FramedPacket[] = [
    { cmd: 'pubrec', messageId: 1, reasonCode: 0 },
    { cmd: 'pubrel', messageId: 1, reasonCode: 0 },
    { cmd: 'pubcomp', messageId: 1, reasonCode: 0x92 },
  ];
  for (const packet of packets) listen(packet);
  expect(received).toEqual(packets);
});

test('rejects AUTH as a protocol error with code 0x82', () => {
  const { received, listen } = listener();
  expect(() => {
    listen({ cmd: 'auth', reasonCode: 0 });
  }).toThrow(expect.objectContaining({ message: 'Unexpected MQTT AUTH', reasonCode: 0x82 }));
  expect(received).toEqual([]);
});

test('delivers decoded bytes as Buffer views of one packet allocation', () => {
  const input = new NodePacketInput();
  const received = vi.fn<(packet: unknown) => void>();
  input.listen(received, () => {});
  const properties = [0x09, 0, 2, 7, 8, 0x26, 0, 1, 0x62, 0, 1, 0x31, 0x26, 0, 1, 0x61, 0, 1, 0x32, 0x26, 0, 1, 0x62, 0, 1, 0x33];
  const body = [0, 1, 0x74, properties.length, ...properties, 0x78, 0x79];
  expect(input.push(Uint8Array.from([0x30, body.length, ...body]))).toBeUndefined();
  expect(received).toHaveBeenCalledTimes(1);
  const message = received.mock.calls[0]?.[0];
  expect(message).toStrictEqual({
    cmd: 'publish',
    topic: 't',
    payload: Buffer.from('xy'),
    qos: 0,
    dup: false,
    retain: false,
    correlationData: Buffer.from([7, 8]),
    userProperties: [
      ['b', '1'],
      ['a', '2'],
      ['b', '3'],
    ],
  });
  if (typeof message !== 'object' || message === null || !('payload' in message) || !('correlationData' in message))
    throw new Error('Expected a message');
  const { payload, correlationData } = message;
  if (!Buffer.isBuffer(payload) || !Buffer.isBuffer(correlationData)) throw new Error('Expected Buffer fields');
  expect(payload.buffer).toBe(correlationData.buffer);
  expect(payload.buffer.byteLength).toBe(body.length + 1);
});

test('rejects a Topic Alias before delivery', () => {
  const input = new NodePacketInput();
  const received = vi.fn<(packet: unknown) => void>();
  input.listen(received, () => {});
  expect(input.push(Uint8Array.of(0x30, 7, 0, 1, 0x74, 3, 0x23, 0, 1))).toBeInstanceOf(Error);
  expect(received).not.toHaveBeenCalled();
});
