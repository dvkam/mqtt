import { getEventListeners } from 'node:events';
import { expect, test, vi } from 'vitest';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';
import { NodePacketInput } from '../src/nodePacketInput.js';
import { PacketDecoder } from '../src/codec.js';
import { createTcpClient, createWebSocketClient } from '../src/index.js';
import { createBrowserClient } from '../src/browser.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

const malformed = [
  { label: 'lone leading byte', bytes: [0xc0] },
  { label: 'null character', bytes: [0] },
  { label: 'overlong encoding', bytes: [0xc0, 0x80] },
  { label: 'surrogate encoding', bytes: [0xed, 0xa0, 0x80] },
] as const;
const fields = ['key', 'value', 'contentType', 'responseTopic'] as const;
type Field = (typeof fields)[number];

function variable(value: number): number[] {
  const bytes: number[] = [];
  do {
    const digit = value % 128;
    value = Math.floor(value / 128);
    bytes.push(digit | (value > 0 ? 128 : 0));
  } while (value > 0);
  return bytes;
}

function stringField(bytes: readonly number[]): number[] {
  return [bytes.length >> 8, bytes.length & 255, ...bytes];
}

function property(field: Field, bytes: readonly number[]): number[] {
  if (field === 'contentType') return [0x03, ...stringField(bytes)];
  if (field === 'responseTopic') return [0x08, ...stringField(bytes)];
  return [0x26, ...stringField(field === 'key' ? bytes : [0x6b]), ...stringField(field === 'value' ? bytes : [0x76])];
}

function publication(properties: readonly number[], qos = 0, payload: readonly number[] = []): Uint8Array {
  const body = [0, 1, 0x61, ...(qos === 0 ? [] : [0, 17]), ...variable(properties.length), ...properties, ...payload];
  return Uint8Array.of(0x30 | (qos << 1), ...variable(body.length), ...body);
}

test('reproduces the fixed malformed User Property wire vectors', () => {
  expect([...publication(property('key', [0xc0]))]).toEqual([0x30, 0x0b, 0, 1, 0x61, 7, 0x26, 0, 1, 0xc0, 0, 1, 0x76]);
  expect([...publication(property('value', [0]))]).toEqual([0x30, 0x0b, 0, 1, 0x61, 7, 0x26, 0, 1, 0x6b, 0, 1, 0]);
});

test.each([0, 1, 2].flatMap((qos) => fields.flatMap((field) => malformed.map((vector) => ({ qos, field, ...vector })))))(
  'rejects $label in $field at QoS $qos at every split',
  ({ qos, field, bytes }: Readonly<{ qos: number; field: Field; bytes: readonly number[] }>) => {
    const frame = publication(property(field, bytes), qos);
    for (let split = 0; split <= frame.length; split++) {
      const received = vi.fn<(packet: unknown) => void>();
      const decoder = new NodePacketDecoder({ onPacket: received });
      let failure: unknown;
      try {
        decoder.push(frame.subarray(0, split));
        decoder.push(frame.subarray(split));
      } catch (reason) {
        failure = reason;
      }
      expect(failure).toMatchObject({ message: 'Invalid MQTT PUBLISH property UTF-8' });
      expect(received).not.toHaveBeenCalled();
      expect(() => {
        decoder.push(Uint8Array.of(0xd0, 0));
      }).toThrow('Invalid MQTT PUBLISH property UTF-8');
      expect(() => {
        decoder.finish();
      }).toThrow('Invalid MQTT PUBLISH property UTF-8');
    }
  },
);

test.each([
  { label: 'string content', properties: [0x03, 0, 2, 0x61], payload: [0x62] },
  { label: 'User Property value', properties: [0x26, 0, 1, 0x6b, 0, 2, 0x61], payload: [0x62] },
  { label: 'binary content', properties: [0x09, 0, 2, 0x61], payload: [0x62] },
  { label: 'fixed-width value', properties: [0x02, 0, 0, 0], payload: [0x26] },
  { label: 'variable integer', properties: [0x0b, 0x80], payload: [1] },
])(
  'never borrows payload bytes for truncated $label',
  ({ properties, payload }: Readonly<{ properties: readonly number[]; payload: readonly number[] }>) => {
    const input = new NodePacketInput();
    const received = vi.fn<(packet: unknown) => void>();
    const failed = vi.fn<(reason: unknown) => void>();
    input.listen(received, failed);
    const failure = input.push(publication(properties, 0, payload));
    expect(failure).toMatchObject({ message: 'Truncated MQTT PUBLISH property' });
    expect(received).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
    expect(input.push(Uint8Array.of(0xd0, 0))).toBe(failure);
    expect(input.remoteEnd(new Error('later EOF'))).toBe(failure);
  },
);

test.each([
  { label: 'empty', bytes: [], expected: '' },
  { label: 'literal replacement character', bytes: [0xef, 0xbf, 0xbd], expected: '\ufffd' },
  { label: 'byte order mark', bytes: [0xef, 0xbb, 0xbf], expected: '\ufeff' },
  { label: 'multibyte text', bytes: [0xc3, 0xa9], expected: 'é' },
])(
  'preserves $label strings and native binary field shapes',
  ({ bytes, expected }: Readonly<{ bytes: readonly number[]; expected: string }>) => {
    const properties = [
      0x01,
      0,
      0x02,
      0,
      0,
      0,
      0x26,
      ...property('contentType', bytes),
      ...property('responseTopic', [0x72]),
      ...property('key', bytes),
      0x09,
      0,
      3,
      0xc0,
      0,
      0x26,
      0x0b,
      1,
      0x0b,
      0x80,
      1,
      0x23,
      0,
      1,
    ];
    const payload = [0xc0, 0, 0x26, 0x03, 0, 0xff];
    for (const qos of [0, 1, 2]) {
      const frame = publication(properties, qos, payload);
      for (let split = 0; split <= frame.length; split++) {
        const received = vi.fn<(packet: unknown) => void>();
        const decoder = new NodePacketDecoder({ onPacket: received });
        decoder.push(frame.subarray(0, split));
        decoder.push(frame.subarray(split));
        expect(received).toHaveBeenCalledTimes(1);
        const packet = received.mock.calls[0]?.[0];
        expect(packet).toMatchObject({
          qos,
          payload: Buffer.from(payload),
          properties: {
            contentType: expected,
            responseTopic: 'r',
            userProperties: { [expected]: 'v' },
            correlationData: Buffer.from([0xc0, 0, 0x26]),
            subscriptionIdentifier: [1, 128],
            topicAlias: 1,
          },
        });
        if (typeof packet !== 'object' || packet === null || !('payload' in packet) || !Buffer.isBuffer(packet.payload))
          throw new Error('Expected native publication payload');
        packet.payload[0] = 42;
        expect(packet.payload[0]).toBe(42);
      }
    }
  },
);

const adapters = ['tcp', 'node-websocket', 'browser'] as const;
type Adapter = (typeof adapters)[number];
test.each(
  adapters.flatMap((adapter) => [0, 1].flatMap((qos) => malformed.slice(0, 2).map((vector) => ({ adapter, qos, ...vector })))),
)(
  '$adapter rejects $label PUBLISH properties at QoS $qos after the valid prefix',
  async ({ adapter, qos, bytes }: Readonly<{ adapter: Adapter; qos: number; bytes: readonly number[] }>) => {
    const response = [0x30, 4, 0, 1, 0x62, 0, ...publication(property('key', bytes), qos), 0x30, 4, 0, 1, 0x7a, 0, 0xd0, 0];
    const peer =
      adapter === 'tcp'
        ? await startTcpPacketPeer('fixed-reply', response)
        : await startWebSocketPacketPeer('fixed-reply', response);
    const controller = new AbortController();
    const onMessage = vi.fn<(packet: unknown) => void>();
    const onQosOneMessage = vi.fn<(packet: unknown) => void>();
    const options = { clientId: 'publish-strings', timeoutMs: 1000, signal: controller.signal, onMessage, onQosOneMessage };
    try {
      const factory =
        'host' in peer
          ? createTcpClient({ ...peer, ...options })
          : adapter === 'browser'
            ? createBrowserClient({ ...peer, ...options })
            : createWebSocketClient({ ...peer, ...options });
      const client = await factory.connect();
      const failure = await client.ping().catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(Error);
      expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topic: 'b' }));
      expect(onQosOneMessage).not.toHaveBeenCalled();
      await expect(client.ping()).rejects.toBe(failure);
      await expect.poll(peer.connections).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(peer.commands).toEqual(['connect', 'pingreq']);
    } finally {
      controller.abort();
      await peer.close();
    }
  },
);

test.each([
  { label: 'missing property length', bytes: [0x30, 3, 0, 1, 0x61] },
  { label: 'missing QoS 1 packet identifier', bytes: [0x32, 3, 0, 1, 0x61] },
  { label: 'partial QoS 1 packet identifier', bytes: [0x32, 4, 0, 1, 0x61, 0] },
  { label: 'property section beyond the frame', bytes: [0x30, 4, 0, 1, 0x61, 7] },
  { label: 'non-canonical property length', bytes: [0x30, 5, 0, 1, 0x61, 0x80, 0] },
  { label: 'unterminated property length', bytes: [0x30, 7, 0, 1, 0x61, 0x80, 0x80, 0x80, 0x80] },
  { label: 'non-canonical property identifier', bytes: [...publication([0x83, 0, 0, 0])] },
  { label: 'non-canonical Subscription Identifier', bytes: [...publication([0x0b, 0x80, 0])] },
  { label: 'property forbidden in PUBLISH', bytes: [...publication([0x1f, 0, 0])] },
])('rejects $label before dispatching a coalesced suffix', ({ bytes }: Readonly<{ bytes: readonly number[] }>) => {
  const input = new NodePacketInput();
  const received = vi.fn<(packet: unknown) => void>();
  const failed = vi.fn<(reason: unknown) => void>();
  input.listen(received, failed);
  const failure = input.push(Uint8Array.of(...bytes, 0xd0, 0));
  expect(failure).toBeInstanceOf(Error);
  expect(received).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
});

test('accepts two-byte frame and property lengths at every split', () => {
  const properties = property(
    'key',
    Array.from({ length: 128 }, () => 0x61),
  );
  const payload = [0xc0, 0, 0x26];
  const frame = publication(properties, 1, payload);
  expect([...frame.subarray(0, 9)]).toEqual([0x32, 0x90, 1, 0, 1, 0x61, 0, 17, 0x86]);
  for (let split = 0; split <= frame.length; split++) {
    const received = vi.fn<(packet: unknown) => void>();
    const decoder = new NodePacketDecoder({ onPacket: received });
    decoder.push(frame.subarray(0, split));
    decoder.push(frame.subarray(split));
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0]?.[0]).toMatchObject({
      messageId: 17,
      payload: Buffer.from(payload),
      properties: { userProperties: { ['a'.repeat(128)]: 'v' } },
    });
  }
  expect(new PacketDecoder().push(frame)).toHaveLength(1);
});

test.each(adapters.flatMap((adapter) => [0, 1].map((qos) => ({ adapter, qos }))))(
  '$adapter preserves valid Unicode properties and opaque payload at QoS $qos',
  async ({ adapter, qos }: Readonly<{ adapter: Adapter; qos: number }>) => {
    const payload = [0xff, 0xc0, 0, 0x26];
    const response = [...publication(property('key', [0xef, 0xbb, 0xbf, 0xef, 0xbf, 0xbd]), qos, payload), 0xd0, 0];
    const peer =
      adapter === 'tcp'
        ? await startTcpPacketPeer('fixed-reply', response)
        : await startWebSocketPacketPeer('fixed-reply', response);
    const onMessage = vi.fn<(packet: unknown) => void>();
    const onQosOneMessage = vi.fn<(packet: unknown) => void>();
    const options = { clientId: 'publish-string-controls', timeoutMs: 1000, onMessage, onQosOneMessage };
    try {
      const factory =
        'host' in peer
          ? createTcpClient({ ...peer, ...options })
          : adapter === 'browser'
            ? createBrowserClient({ ...peer, ...options })
            : createWebSocketClient({ ...peer, ...options });
      const client = await factory.connect();
      await client.ping();
      const received = qos === 0 ? onMessage : onQosOneMessage;
      const other = qos === 0 ? onQosOneMessage : onMessage;
      expect(received).toHaveBeenCalledTimes(1);
      expect(other).not.toHaveBeenCalled();
      const packet = received.mock.calls[0]?.[0];
      if (typeof packet !== 'object' || packet === null || !('payload' in packet) || !(packet.payload instanceof Uint8Array))
        throw new Error('Expected publication bytes');
      expect([...packet.payload]).toEqual(payload);
      const key = '\ufeff\ufffd';
      const expected =
        adapter === 'browser' ? { userProperties: [[key, 'v']] } : { properties: { userProperties: { [key]: 'v' } } };
      expect(packet).toMatchObject(expected);
      await expect.poll(() => peer.commands).toEqual(qos === 0 ? ['connect', 'pingreq'] : ['connect', 'pingreq', 'puback']);
      await client.disconnect();
    } finally {
      await peer.close();
    }
  },
);

test.each(
  [0, 1].flatMap((qos) => (['key', 'value'] as const).flatMap((field) => malformed.map((vector) => ({ qos, field, ...vector })))),
)(
  'portable decoder rejects $label in User Property $field at QoS $qos',
  ({ qos, field, bytes }: Readonly<{ qos: number; field: Field; bytes: readonly number[] }>) => {
    expect(() => new PacketDecoder().push(publication(property(field, bytes), qos))).toThrow(/utf-8|encoding/i);
  },
);
