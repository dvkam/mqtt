import { expect, test, vi } from 'vitest';
import { createBrowserClient } from '../src/browser.js';
import { createTcpClient, createWebSocketClient } from '../src/index.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

const adapters = ['tcp', 'node-websocket', 'browser'] as const;
type Adapter = (typeof adapters)[number];

async function openPeer(adapter: Adapter, reply: readonly number[], onMessage: (packet: unknown) => void) {
  const peer = await (adapter === 'tcp'
    ? startTcpPacketPeer('fixed-reply', reply)
    : startWebSocketPacketPeer('fixed-reply', reply));
  const options = { clientId: 'topic-test', onMessage, timeoutMs: 1000 };
  return {
    close: peer.close,
    open: async () => {
      if ('host' in peer) return createTcpClient({ ...peer, ...options }).connect();
      if (adapter === 'browser') return createBrowserClient({ ...peer, ...options }).connect();
      return createWebSocketClient({ ...peer, ...options }).connect();
    },
  };
}

test.each(
  adapters.flatMap((adapter) =>
    [
      { kind: 'overlong UTF-8', bytes: [0x30, 5, 0, 2, 0xc0, 0x80, 0] },
      { kind: 'NUL', bytes: [0x30, 4, 0, 1, 0, 0] },
      { kind: 'a truncated length field', bytes: [0x30, 1, 0] },
      { kind: 'truncated topic bytes', bytes: [0x30, 3, 0, 2, 0x61] },
    ].map(({ kind, bytes }: Readonly<{ kind: string; bytes: readonly number[] }>) => ({ adapter, kind, bytes })),
  ),
)(
  '$adapter rejects a PUBLISH topic containing $kind before delivery',
  async ({ adapter, bytes }: Readonly<{ adapter: Adapter; bytes: readonly number[] }>) => {
    const onMessage = vi.fn<(packet: unknown) => void>();
    const peer = await openPeer(adapter, [...bytes, 0xd0, 0], onMessage);
    try {
      const client = await peer.open();
      const failure = await client.ping().catch((reason: unknown) => reason);
      expect(onMessage).not.toHaveBeenCalled();
      if (!(failure instanceof Error)) throw new Error('Expected malformed topic rejection');
      expect(failure.message).toMatch(/utf-8|truncated mqtt/i);
      await expect(client.ping()).rejects.toBe(failure);
    } finally {
      await peer.close();
    }
  },
);

test.each(adapters)('%s preserves well-formed Unicode and leaves binary payload opaque', async (adapter) => {
  const onMessage = vi.fn<(packet: unknown) => void>();
  const reply = [0x30, 15, 0, 10, 0xef, 0xbb, 0xbf, 0xef, 0xbf, 0xbd, 0xf0, 0x9f, 0x98, 0x80, 0, 0xc0, 0x80, 0xd0, 0];
  const peer = await openPeer(adapter, reply, onMessage);
  try {
    const client = await peer.open();
    await client.ping();
    const packet = onMessage.mock.calls[0]?.[0];
    expect(packet).toMatchObject({ topic: '\ufeff\ufffd😀' });
    expect(packet).toHaveProperty('payload');
    const payload = typeof packet === 'object' && packet !== null && 'payload' in packet ? packet.payload : undefined;
    expect(payload instanceof Uint8Array && Array.from(payload)).toEqual([0xc0, 0x80]);
    await client.disconnect();
  } finally {
    await peer.close();
  }
});
