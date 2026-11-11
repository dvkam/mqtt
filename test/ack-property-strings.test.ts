import { getEventListeners } from 'node:events';
import { expect, test, vi } from 'vitest';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';
import { NodePacketInput } from '../src/nodePacketInput.js';
import { PacketDecoder } from '../src/codec.js';
import { createTcpClient, createWebSocketClient } from '../src/index.js';
import { createBrowserClient } from '../src/browser.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

const acknowledgments = [
  { command: 'puback', header: 0x40, subscription: false },
  { command: 'pubrec', header: 0x50, subscription: false },
  { command: 'pubrel', header: 0x62, subscription: false },
  { command: 'pubcomp', header: 0x70, subscription: false },
  { command: 'suback', header: 0x90, subscription: true },
  { command: 'unsuback', header: 0xb0, subscription: true },
] as const;
type Acknowledgment = (typeof acknowledgments)[number];

const invalidStrings = [
  { label: 'lone leading byte', bytes: [0xc0] },
  { label: 'null character', bytes: [0] },
  { label: 'overlong encoding', bytes: [0xc0, 0x80] },
  { label: 'surrogate encoding', bytes: [0xed, 0xa0, 0x80] },
] as const;
const fields = ['reasonString', 'key', 'value'] as const;
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
  if (field === 'reasonString') return [0x1f, ...stringField(bytes)];
  return [0x26, ...stringField(field === 'key' ? bytes : [0x6b]), ...stringField(field === 'value' ? bytes : [0x76])];
}

function acknowledgment(packet: Acknowledgment, properties: readonly number[]): Uint8Array {
  const body = [
    0,
    1,
    ...(packet.subscription ? [] : [0]),
    ...variable(properties.length),
    ...properties,
    ...(packet.subscription ? [0] : []),
  ];
  return Uint8Array.of(packet.header, ...variable(body.length), ...body);
}

test('locks down the independent PUBACK and SUBACK malformed vectors', () => {
  expect([...acknowledgment(acknowledgments[0], property('reasonString', [0xc0]))]).toEqual([
    0x40, 8, 0, 1, 0, 4, 0x1f, 0, 1, 0xc0,
  ]);
  expect([...acknowledgment(acknowledgments[4], property('value', [0]))]).toEqual([
    0x90, 11, 0, 1, 7, 0x26, 0, 1, 0x6b, 0, 1, 0, 0,
  ]);
});

test.each(
  acknowledgments.flatMap((packet) => fields.flatMap((field) => invalidStrings.map((vector) => ({ packet, field, ...vector })))),
)(
  '$packet.command rejects $label in $field at every split before native conversion',
  ({ packet, field, bytes }: Readonly<{ packet: Acknowledgment; field: Field; bytes: readonly number[] }>) => {
    const command = packet.command;
    const frame = acknowledgment(packet, property(field, bytes));
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
      expect(failure).toMatchObject({ message: 'Invalid MQTT ' + command.toUpperCase() + ' property UTF-8' });
      expect(received).not.toHaveBeenCalled();
      expect(() => {
        decoder.push(Uint8Array.of(0xd0, 0));
      }).toThrow('Invalid MQTT ' + command.toUpperCase() + ' property UTF-8');
      expect(() => {
        decoder.finish();
      }).toThrow('Invalid MQTT ' + command.toUpperCase() + ' property UTF-8');
    }
  },
);

test.each(
  acknowledgments.flatMap((packet) =>
    [
      { label: 'empty', bytes: [], expected: '' },
      { label: 'literal replacement', bytes: [0xef, 0xbf, 0xbd], expected: '\ufffd' },
      { label: 'byte order mark', bytes: [0xef, 0xbb, 0xbf], expected: '\ufeff' },
      { label: 'multibyte', bytes: [0xc3, 0xa9], expected: 'é' },
    ].map((value: Readonly<{ label: string; bytes: readonly number[]; expected: string }>) => ({ packet, ...value })),
  ),
)(
  '$packet.command preserves $label strings and repeated User Properties',
  ({ packet, bytes, expected }: Readonly<{ packet: Acknowledgment; bytes: readonly number[]; expected: string }>) => {
    const frame = acknowledgment(packet, [
      ...property('reasonString', bytes),
      ...property('key', bytes),
      ...property('key', bytes),
    ]);
    for (let split = 0; split <= frame.length; split++) {
      const received = vi.fn<(packet: unknown) => void>();
      const decoder = new NodePacketDecoder({ onPacket: received });
      decoder.push(frame.subarray(0, split));
      decoder.push(frame.subarray(split));
      expect(received).toHaveBeenCalledTimes(1);
      expect(received.mock.calls[0]?.[0]).toMatchObject({
        cmd: packet.command,
        messageId: 1,
        properties: { reasonString: expected, userProperties: { [expected]: ['v', 'v'] } },
      });
    }
  },
);

test.each(acknowledgments.slice(0, 4).flatMap((packet) => [[], [0]].map((reason: readonly number[]) => ({ packet, reason }))))(
  '$packet.command preserves its short form with $reason reason bytes',
  ({ packet, reason }: Readonly<{ packet: Acknowledgment; reason: readonly number[] }>) => {
    const received = vi.fn<(packet: unknown) => void>();
    const decoder = new NodePacketDecoder({ onPacket: received });
    decoder.push(Uint8Array.of(packet.header, 2 + reason.length, 0, 1, ...reason));
    expect(received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cmd: packet.command, messageId: 1, reasonCode: 0 }));
  },
);

test.each(acknowledgments.slice(4))('$command cannot borrow reason bytes for a truncated string', (packet) => {
  const input = new NodePacketInput();
  const received = vi.fn<(packet: unknown) => void>();
  const failed = vi.fn<(reason: unknown) => void>();
  input.listen(received, failed);
  const frame = acknowledgment(packet, [0x1f, 0, 2, 0x61]);
  frame[frame.length - 1] = packet.command === 'suback' ? 1 : 0x11;
  const failure = input.push(Uint8Array.of(...frame, 0xd0, 0));
  expect(failure).toMatchObject({ message: 'Truncated MQTT ' + packet.command.toUpperCase() + ' property' });
  expect(received).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
  expect(input.push(Uint8Array.of(0xd0, 0))).toBe(failure);
  expect(input.remoteEnd(new Error('later EOF'))).toBe(failure);
});

const supported = [acknowledgments[0], acknowledgments[4], acknowledgments[5]] as const;
const adapters = ['tcp', 'node-websocket', 'browser'] as const;
type Adapter = (typeof adapters)[number];

test.each(
  adapters.flatMap((adapter) =>
    supported.flatMap((packet) => invalidStrings.slice(0, 2).map((vector) => ({ adapter, packet, ...vector }))),
  ),
)(
  '$adapter never completes $packet.command with $label properties',
  async ({ adapter, packet, bytes }: Readonly<{ adapter: Adapter; packet: Acknowledgment; bytes: readonly number[] }>) => {
    const mode =
      packet.command === 'puback' ? 'fixed-publish' : packet.command === 'suback' ? 'fixed-subscribe' : 'fixed-unsubscribe';
    const response = [0x30, 4, 0, 1, 0x62, 0, ...acknowledgment(packet, property('reasonString', bytes)), 0x30, 4, 0, 1, 0x7a, 0];
    const peer = adapter === 'tcp' ? await startTcpPacketPeer(mode, response) : await startWebSocketPacketPeer(mode, response);
    const controller = new AbortController();
    const onMessage = vi.fn<(packet: unknown) => void>();
    const options = { clientId: 'ack-string-regression', timeoutMs: 1000, signal: controller.signal, onMessage };
    try {
      const factory =
        'host' in peer
          ? createTcpClient({ ...peer, ...options })
          : adapter === 'browser'
            ? createBrowserClient({ ...peer, ...options })
            : createWebSocketClient({ ...peer, ...options });
      const client = await factory.connect();
      const operation =
        packet.command === 'puback'
          ? client.publish('ack', 'payload', { qos: 1 })
          : packet.command === 'suback'
            ? client.subscribe('ack')
            : client.unsubscribe('ack');
      const failure = await operation.catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(Error);
      expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topic: 'b' }));
      await expect(client.ping()).rejects.toBe(failure);
      await expect.poll(peer.connections).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      controller.abort();
      await peer.close();
    }
  },
);

test.each(supported.flatMap((packet) => fields.flatMap((field) => invalidStrings.map((vector) => ({ packet, field, ...vector })))))(
  'portable $packet.command rejects $label in $field',
  ({ packet, field, bytes }: Readonly<{ packet: Acknowledgment; field: Field; bytes: readonly number[] }>) => {
    expect(() => new PacketDecoder().push(acknowledgment(packet, property(field, bytes)))).toThrow(/utf-8|encoding/i);
  },
);

test.each(
  acknowledgments.flatMap((packet) =>
    [
      { label: 'non-canonical property length', bytes: [0x80, 0] },
      { label: 'property section exceeding frame', bytes: [0x7f] },
      { label: 'non-canonical property identifier', bytes: [4, 0x9f, 0, 0, 0] },
      { label: 'forbidden property identifier', bytes: [3, 0x03, 0, 0] },
    ].map((value: Readonly<{ label: string; bytes: readonly number[] }>) => ({ packet, ...value })),
  ),
)(
  '$packet.command rejects $label before the next frame',
  ({ packet, bytes }: Readonly<{ packet: Acknowledgment; bytes: readonly number[] }>) => {
    const body = [0, 1, ...(packet.subscription ? [] : [0]), ...bytes, ...(packet.subscription ? [0] : [])];
    const received = vi.fn<(packet: unknown) => void>();
    const input = new NodePacketInput();
    input.listen(received, () => {});
    expect(input.push(Uint8Array.of(packet.header, ...variable(body.length), ...body, 0xd0, 0))).toBeInstanceOf(Error);
    expect(received).not.toHaveBeenCalled();
  },
);

test.each(acknowledgments.slice(0, 4))('$command rejects bytes outside its declared properties', (packet) => {
  const input = new NodePacketInput();
  const received = vi.fn<(packet: unknown) => void>();
  input.listen(received, () => {});
  expect(input.push(Uint8Array.of(packet.header, 5, 0, 1, 0, 0, 0))).toMatchObject({
    message: 'Invalid MQTT ' + packet.command.toUpperCase() + ' property length',
  });
  expect(received).not.toHaveBeenCalled();
});

test.each(adapters.flatMap((adapter) => supported.map((packet) => ({ adapter, packet }))))(
  '$adapter accepts well-formed $packet.command properties and remains usable',
  async ({ adapter, packet }: Readonly<{ adapter: Adapter; packet: Acknowledgment }>) => {
    const mode =
      packet.command === 'puback' ? 'fixed-publish' : packet.command === 'suback' ? 'fixed-subscribe' : 'fixed-unsubscribe';
    const response = [
      ...acknowledgment(packet, [...property('reasonString', [0xef, 0xbb, 0xbf]), ...property('key', [0xef, 0xbf, 0xbd])]),
    ];
    const peer = adapter === 'tcp' ? await startTcpPacketPeer(mode, response) : await startWebSocketPacketPeer(mode, response);
    const options = { clientId: 'ack-string-controls', timeoutMs: 1000 };
    try {
      const factory =
        'host' in peer
          ? createTcpClient({ ...peer, ...options })
          : adapter === 'browser'
            ? createBrowserClient({ ...peer, ...options })
            : createWebSocketClient({ ...peer, ...options });
      const client = await factory.connect();
      const operation =
        packet.command === 'puback'
          ? client.publish('ack', 'payload', { qos: 1 })
          : packet.command === 'suback'
            ? client.subscribe('ack')
            : client.unsubscribe('ack');
      await operation;
      await client.ping();
      expect(peer.commands).toContain('pingreq');
      await client.disconnect();
    } finally {
      await peer.close();
    }
  },
);

test.each(acknowledgments.slice(0, 4))('$command accepts an omitted property length after an explicit reason', (packet) => {
  const reasonCode = packet.command === 'puback' || packet.command === 'pubrec' ? 0x10 : 0x92;
  const received = vi.fn<(packet: unknown) => void>();
  const decoder = new NodePacketDecoder({ onPacket: received });
  decoder.push(Uint8Array.of(packet.header, 3, 0, 1, reasonCode));
  expect(received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cmd: packet.command, messageId: 1, reasonCode }));
});

test.each([acknowledgments[0], acknowledgments[4]])('$command preserves long properties at every split', (packet) => {
  const text = 'a'.repeat(128);
  const frame = acknowledgment(packet, property('reasonString', [...new TextEncoder().encode(text)]));
  const prefix = packet.subscription ? [0x90, 0x88, 1, 0, 1, 0x83, 1, 0x1f] : [0x40, 0x88, 1, 0, 1, 0, 0x83, 1];
  expect([...frame.subarray(0, 8)]).toEqual(prefix);
  for (let split = 0; split <= frame.length; split++) {
    const received = vi.fn<(packet: unknown) => void>();
    const decoder = new NodePacketDecoder({ onPacket: received });
    decoder.push(frame.subarray(0, split));
    decoder.push(frame.subarray(split));
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0]?.[0]).toMatchObject({
      cmd: packet.command,
      messageId: 1,
      properties: { reasonString: text },
    });
  }
  expect(new PacketDecoder().push(frame)).toHaveLength(1);
});

test.each(acknowledgments.slice(4))('$command requires its property length even without properties', (packet) => {
  const received = vi.fn<(packet: unknown) => void>();
  const decoder = new NodePacketDecoder({ onPacket: received });
  expect(() => {
    decoder.push(Uint8Array.of(packet.header, 2, 0, 1));
  }).toThrow('Truncated MQTT ' + packet.command.toUpperCase() + ' property');
  expect(received).not.toHaveBeenCalled();
});
