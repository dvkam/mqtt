import { getEventListeners } from 'node:events';
import { expect, test, vi } from 'vitest';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';
import { NodePacketInput } from '../src/nodePacketInput.js';
import { createTcpClient, createWebSocketClient } from '../src/index.js';
import { createBrowserClient } from '../src/browser.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

const invalidStrings = [
  { label: 'lone leading byte', bytes: [0xc0] },
  { label: 'null character', bytes: [0] },
  { label: 'overlong encoding', bytes: [0xc0, 0x80] },
  { label: 'surrogate encoding', bytes: [0xed, 0xa0, 0x80] },
] as const;
const fields = ['reasonString', 'serverReference', 'key', 'value'] as const;
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
  if (field === 'serverReference') return [0x1c, ...stringField(bytes)];
  return [0x26, ...stringField(field === 'key' ? bytes : [0x6b]), ...stringField(field === 'value' ? bytes : [0x76])];
}

function disconnect(properties: readonly number[], reason = 0x8e): Uint8Array {
  const body = [reason, ...variable(properties.length), ...properties];
  return Uint8Array.of(0xe0, ...variable(body.length), ...body);
}

test('locks down the recorded malformed DISCONNECT vectors', () => {
  expect([...disconnect(property('reasonString', [0xc0]), 0)]).toEqual([0xe0, 6, 0, 4, 0x1f, 0, 1, 0xc0]);
  expect([...disconnect(property('key', [0]), 0)]).toEqual([0xe0, 9, 0, 7, 0x26, 0, 1, 0, 0, 1, 0x76]);
});

test.each(fields.flatMap((field) => invalidStrings.map((vector) => ({ field, ...vector }))))(
  'rejects $label in $field before dispatch at every split',
  ({ field, bytes }: Readonly<{ field: Field; bytes: readonly number[] }>) => {
    const frame = disconnect(property(field, bytes));
    for (let split = 0; split <= frame.length; split++) {
      const input = new NodePacketInput();
      const received = vi.fn<(packet: unknown) => void>();
      const failed = vi.fn<(reason: unknown) => void>();
      input.listen(received, failed);
      input.push(frame.subarray(0, split));
      const failure = input.push(frame.subarray(split));
      expect(failure).toMatchObject({ message: 'Invalid MQTT DISCONNECT property UTF-8' });
      expect(received).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
      expect(input.push(Uint8Array.of(0xd0, 0))).toBe(failure);
      expect(input.remoteEnd(new Error('later EOF'))).toBe(failure);
    }
  },
);

test.each([
  { label: 'empty', bytes: [], expected: '' },
  { label: 'literal replacement', bytes: [0xef, 0xbf, 0xbd], expected: '\ufffd' },
  { label: 'byte order mark', bytes: [0xef, 0xbb, 0xbf], expected: '\ufeff' },
  { label: 'multibyte', bytes: [0xc3, 0xa9], expected: 'é' },
])(
  'preserves $label DISCONNECT strings and repeated User Properties',
  ({ bytes, expected }: Readonly<{ bytes: readonly number[]; expected: string }>) => {
    const frame = disconnect([
      ...property('reasonString', bytes),
      ...property('serverReference', bytes),
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
        cmd: 'disconnect',
        reasonCode: 0x8e,
        properties: { reasonString: expected, serverReference: expected, userProperties: { [expected]: ['v', 'v'] } },
      });
    }
  },
);

test.each([
  [0xe0, 0],
  [0xe0, 1, 0],
  [0xe0, 1, 0x8e],
  [0xe0, 2, 0, 0],
])('preserves compact DISCONNECT %j', (...bytes: readonly number[]) => {
  const received = vi.fn<(packet: unknown) => void>();
  const decoder = new NodePacketDecoder({ onPacket: received });
  decoder.push(Uint8Array.from(bytes));
  expect(received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cmd: 'disconnect', reasonCode: bytes[2] ?? 0 }));
});

test.each([
  { label: 'excess property length', bytes: [0xe0, 2, 0, 127] },
  { label: 'trailing bytes', bytes: [0xe0, 3, 0, 0, 0] },
  { label: 'non-canonical length', bytes: [0xe0, 3, 0, 0x80, 0] },
  { label: 'non-canonical identifier', bytes: [...disconnect([0x9f, 0, 0, 0])] },
  { label: 'truncated string', bytes: [...disconnect([0x1f, 0, 2, 0x61])] },
  { label: 'server Session Expiry Interval', bytes: [...disconnect([0x11, 0, 0, 0, 0])] },
  { label: 'unknown property', bytes: [...disconnect([0x7f])] },
])('rejects $label without reading the next frame', ({ bytes }: Readonly<{ bytes: readonly number[] }>) => {
  const input = new NodePacketInput();
  const received = vi.fn<(packet: unknown) => void>();
  input.listen(received, () => {});
  expect(input.push(Uint8Array.of(...bytes, 0xd0, 0))).toBeInstanceOf(Error);
  expect(received).not.toHaveBeenCalled();
});

test('preserves a long Reason String at every split', () => {
  const text = 'a'.repeat(128);
  const frame = disconnect(property('reasonString', [...new TextEncoder().encode(text)]));
  expect([...frame.subarray(0, 6)]).toEqual([0xe0, 0x86, 1, 0x8e, 0x83, 1]);
  for (let split = 0; split <= frame.length; split++) {
    const received = vi.fn<(packet: unknown) => void>();
    const decoder = new NodePacketDecoder({ onPacket: received });
    decoder.push(frame.subarray(0, split));
    decoder.push(frame.subarray(split));
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0]?.[0]).toMatchObject({ properties: { reasonString: text } });
  }
});

test.each(['tcp', 'node-websocket'] as const)(
  '%s reports the malformed packet before interpreting its DISCONNECT reason',
  async (adapter) => {
    const reply = [0x30, 4, 0, 1, 0x62, 0, ...disconnect(property('reasonString', [0xc0])), 0x30, 4, 0, 1, 0x7a, 0];
    const peer =
      adapter === 'tcp' ? await startTcpPacketPeer('fixed-reply', reply) : await startWebSocketPacketPeer('fixed-reply', reply);
    const controller = new AbortController();
    const onMessage = vi.fn<(packet: unknown) => void>();
    const onSessionEnd = vi.fn<(event: unknown) => void>();
    const options = { clientId: 'disconnect-strings', timeoutMs: 1000, signal: controller.signal, onMessage, onSessionEnd };
    try {
      const client = await (
        'host' in peer ? createTcpClient({ ...peer, ...options }) : createWebSocketClient({ ...peer, ...options })
      ).connect();
      const failure = await client.ping().catch((reason: unknown) => reason);
      expect(failure).toMatchObject({ message: 'Invalid MQTT DISCONNECT property UTF-8' });
      expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topic: 'b' }));
      await expect(client.ping()).rejects.toBe(failure);
      await expect.poll(peer.connections).toBe(0);
      expect(onSessionEnd).toHaveBeenCalledExactlyOnceWith({ kind: 'error', error: failure });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      controller.abort();
      await peer.close();
    }
  },
);

test.each(['tcp', 'node-websocket', 'browser'] as const)('%s preserves a compact reasoned DISCONNECT', async (adapter) => {
  const peer =
    adapter === 'tcp'
      ? await startTcpPacketPeer('fixed-reply', [0xe0, 1, 0x82])
      : await startWebSocketPacketPeer('fixed-reply', [0xe0, 1, 0x82]);
  const options = { clientId: 'disconnect-compact', timeoutMs: 1000 };
  try {
    const factory =
      'host' in peer
        ? createTcpClient({ ...peer, ...options })
        : adapter === 'browser'
          ? createBrowserClient({ ...peer, ...options })
          : createWebSocketClient({ ...peer, ...options });
    const client = await factory.connect();
    const failure = await client.ping().catch((reason: unknown) => reason);
    expect(failure).toMatchObject({ message: 'MQTT broker disconnected', code: 0x82 });
    await expect(client.ping()).rejects.toBe(failure);
    await expect.poll(peer.connections).toBe(0);
  } finally {
    await peer.close();
  }
});
