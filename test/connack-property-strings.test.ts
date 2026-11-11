import { getEventListeners } from 'node:events';
import { expect, test, vi } from 'vitest';
import { PacketDecoder } from '../src/codec.js';
import { NodePacketInput } from '../src/nodePacketInput.js';
import { createTcpClient, createWebSocketClient } from '../src/index.js';
import { createBrowserClient } from '../src/browser.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

const invalidStrings = [
  { label: 'recorded lone leading byte', bytes: [0xc0] },
  { label: 'recorded null character', bytes: [0] },
  { label: 'overlong encoding', bytes: [0xc0, 0x80] },
  { label: 'surrogate encoding', bytes: [0xed, 0xa0, 0x80] },
] as const;

function stringField(bytes: readonly number[]): number[] {
  return [bytes.length >> 8, bytes.length & 255, ...bytes];
}

function connack(properties: readonly number[]): Uint8Array {
  const body = [0, 0, properties.length, ...properties];
  return Uint8Array.of(0x20, body.length, ...body);
}

test.each(invalidStrings.flatMap((vector) => ['key', 'value'].map((field) => ({ ...vector, field }))))(
  'rejects $label in a User Property $field at every split and preserves its first error',
  ({ bytes, field }: Readonly<{ bytes: readonly number[]; field: string }>) => {
    const frame = connack([
      0x26,
      ...stringField(field === 'key' ? bytes : [0x61]),
      ...stringField(field === 'value' ? bytes : [0x78]),
    ]);
    for (let split = 0; split <= frame.length; split++) {
      const input = new NodePacketInput();
      const received = vi.fn<(packet: unknown) => void>();
      const failed = vi.fn<(reason: unknown) => void>();
      input.listen(received, failed);
      input.push(frame.subarray(0, split));
      const failure = input.push(frame.subarray(split));
      expect(failure).toBeInstanceOf(Error);
      expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
      expect(received).not.toHaveBeenCalled();
      expect(input.push(Uint8Array.of(0xd0, 0))).toBe(failure);
      expect(input.remoteEnd(new Error('later EOF'))).toBe(failure);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(() => new PacketDecoder().push(frame)).toThrow(/utf-8|encoding/i);
    }
  },
);

test.each([0x12, 0x15, 0x1a, 0x1c, 0x1f])('validates CONNACK string property %i before conversion', (identifier) => {
  const input = new NodePacketInput();
  const received = vi.fn<(packet: unknown) => void>();
  input.listen(received, () => {});
  expect(input.push(connack([identifier, 0, 1, 0xc0]))).toBeInstanceOf(Error);
  expect(received).not.toHaveBeenCalled();
});

test.each([
  { label: 'empty', bytes: [], expected: '' },
  { label: 'literal replacement character', bytes: [0xef, 0xbf, 0xbd], expected: '\ufffd' },
  { label: 'byte order mark', bytes: [0xef, 0xbb, 0xbf], expected: '\ufeff' },
  { label: 'multibyte text', bytes: [0xc3, 0xa9], expected: 'é' },
])(
  'preserves valid $label keys, repeated properties and opaque binary data',
  ({ bytes, expected }: Readonly<{ bytes: readonly number[]; expected: string }>) => {
    const properties = [
      0x11,
      0,
      0,
      0,
      0,
      0x13,
      0,
      20,
      0x21,
      0,
      2,
      0x22,
      0,
      0,
      0x24,
      1,
      0x25,
      1,
      0x27,
      0,
      0,
      4,
      0,
      0x28,
      1,
      0x29,
      1,
      0x2a,
      1,
      0x26,
      ...stringField(bytes),
      0,
      1,
      0x78,
      0x16,
      0,
      3,
      0xc0,
      0,
      0x26,
      0x26,
      ...stringField(bytes),
      0,
      1,
      0x79,
    ];
    const frame = connack(properties);
    const input = new NodePacketInput();
    const received = vi.fn<(packet: unknown) => void>();
    const failed = vi.fn<(reason: unknown) => void>();
    input.listen(received, failed);
    expect(input.push(frame)).toBeUndefined();
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0]?.[0]).toMatchObject({
      properties: {
        userProperties: { [expected]: ['x', 'y'] },
        authenticationData: Buffer.from([0xc0, 0, 0x26]),
      },
    });
    expect(failed).not.toHaveBeenCalled();
  },
);

test('delivers only the accepted wire prefix before a malformed CONNACK property', () => {
  const input = new NodePacketInput();
  const received = vi.fn<(packet: unknown) => void>();
  const failed = vi.fn<(reason: unknown) => void>();
  input.listen(received, failed);
  const malformed = connack([0x26, 0, 1, 0xc0, 0, 1, 0x78]);
  const failure = input.push(Uint8Array.of(0xd0, 0, ...malformed, 0xd0, 0));
  expect(failure).toBeInstanceOf(Error);
  expect(received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cmd: 'pingresp' }));
  expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
});

const adapters = ['tcp', 'node-websocket', 'browser'] as const;
test.each(adapters.flatMap((adapter) => invalidStrings.slice(0, 2).map((vector) => ({ adapter, ...vector }))))(
  '$adapter rejects opening with $label and closes before fixture cleanup',
  async ({ adapter, bytes }: Readonly<{ adapter: (typeof adapters)[number]; bytes: readonly number[] }>) => {
    const response = [...connack([0x26, 0, 1, ...bytes, 0, 1, 0x78])];
    const peer =
      adapter === 'tcp'
        ? await startTcpPacketPeer('fixed-connect', response)
        : await startWebSocketPacketPeer('fixed-connect', response);
    const controller = new AbortController();
    const onMessage = vi.fn<(packet: unknown) => void>();
    const options = { clientId: 'property-strings', timeoutMs: 1000, signal: controller.signal, onMessage };
    try {
      const factory =
        'host' in peer
          ? createTcpClient({ ...peer, ...options })
          : adapter === 'browser'
            ? createBrowserClient({ ...peer, ...options })
            : createWebSocketClient({ ...peer, ...options });
      const opening = factory.connect();
      expect(factory.connect()).toBe(opening);
      const failure = await opening.catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(Error);
      await expect(factory.connect()).rejects.toBe(failure);
      await expect.poll(peer.connections).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(peer.commands).toEqual(['connect']);
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await peer.close();
    }
  },
);

test.each([
  { label: 'missing property length', bytes: [0x20, 2, 0, 0] },
  { label: 'unterminated property length', bytes: [0x20, 3, 0, 0, 0x80] },
  { label: 'non-canonical property length', bytes: [0x20, 4, 0, 0, 0x80, 0] },
  { label: 'property section exceeding the frame', bytes: [0x20, 3, 0, 0, 7] },
  { label: 'trailing bytes outside the property section', bytes: [0x20, 4, 0, 0, 0, 0] },
  { label: 'User Property string exceeding the section', bytes: [0x20, 6, 0, 0, 3, 0x26, 0, 2] },
  { label: 'non-canonical property identifier', bytes: [0x20, 9, 0, 0, 6, 0xa6, 0, 0, 0, 0, 0] },
  { label: 'truncated binary field', bytes: [0x20, 7, 0, 0, 4, 0x16, 0, 2, 0x61] },
  { label: 'truncated fixed-width field', bytes: [0x20, 5, 0, 0, 2, 0x21, 0] },
  { label: 'property forbidden in CONNACK', bytes: [0x20, 5, 0, 0, 2, 0x01, 0] },
])('rejects $label without consuming the next packet', ({ bytes }: Readonly<{ bytes: readonly number[] }>) => {
  const input = new NodePacketInput();
  const received = vi.fn<(packet: unknown) => void>();
  const failed = vi.fn<(reason: unknown) => void>();
  input.listen(received, failed);
  const failure = input.push(Uint8Array.from([...bytes, 0xd0, 0]));
  expect(failure).toBeInstanceOf(Error);
  expect(received).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
});

test.each([
  { identifier: 0x12, name: 'assignedClientIdentifier' },
  { identifier: 0x15, name: 'authenticationMethod' },
  { identifier: 0x1a, name: 'responseInformation' },
  { identifier: 0x1c, name: 'serverReference' },
  { identifier: 0x1f, name: 'reasonString' },
])('preserves the native $name string contract', ({ identifier, name }: Readonly<{ identifier: number; name: string }>) => {
  const input = new NodePacketInput();
  const received = vi.fn<(packet: unknown) => void>();
  input.listen(received, () => {});
  expect(input.push(connack([identifier, 0, 3, 0xef, 0xbb, 0xbf]))).toBeUndefined();
  expect(received).toHaveBeenCalledTimes(1);
  expect(received.mock.calls[0]?.[0]).toMatchObject({ properties: { [name]: '\ufeff' } });
});

test('accepts a two-byte property length and Remaining Length at every split', () => {
  const key = 'a'.repeat(128);
  const frame = Uint8Array.of(0x20, 0x89, 1, 0, 0, 0x85, 1, 0x26, 0, 0x80, ...new TextEncoder().encode(key), 0, 0);
  for (let split = 0; split <= frame.length; split++) {
    const input = new NodePacketInput();
    const received = vi.fn<(packet: unknown) => void>();
    input.listen(received, () => {});
    expect(input.push(frame.subarray(0, split))).toBeUndefined();
    expect(input.push(frame.subarray(split))).toBeUndefined();
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0]?.[0]).toMatchObject({ properties: { userProperties: { [key]: '' } } });
  }
  expect(new PacketDecoder().push(frame)).toHaveLength(1);
});

test.each(adapters)('%s preserves an earlier refusal before a malformed property suffix', async (adapter) => {
  const response = [0x20, 3, 0, 0x87, 0, ...connack([0x26, 0, 1, 0xc0, 0, 1, 0x78]), 0xd0, 0];
  const peer =
    adapter === 'tcp'
      ? await startTcpPacketPeer('fixed-connect', response)
      : await startWebSocketPacketPeer('fixed-connect', response);
  try {
    const options = { clientId: 'refusal-before-property', timeoutMs: 1000 };
    const factory =
      'host' in peer
        ? createTcpClient({ ...peer, ...options })
        : adapter === 'browser'
          ? createBrowserClient({ ...peer, ...options })
          : createWebSocketClient({ ...peer, ...options });
    const failure = await factory.connect().catch((reason: unknown) => reason);
    expect(failure).toMatchObject({ code: 0x87 });
    await expect(factory.connect()).rejects.toBe(failure);
    await expect.poll(peer.connections).toBe(0);
  } finally {
    await peer.close();
  }
});
