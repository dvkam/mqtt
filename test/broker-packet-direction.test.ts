import { expect, test, vi } from 'vitest';
import { createBrowserClient } from '../src/browser.js';
import { createTcpClient, createWebSocketClient } from '../src/index.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

const adapters = ['tcp', 'node-websocket', 'browser'] as const;
type Adapter = (typeof adapters)[number];

const wrongDirection = [
  { command: 'CONNECT', bytes: [0x10, 14, 0, 4, 0x4d, 0x51, 0x54, 0x54, 5, 2, 0, 0, 0, 0, 1, 0x61] },
  { command: 'SUBSCRIBE', bytes: [0x82, 7, 0, 1, 0, 0, 1, 0x61, 0] },
  { command: 'UNSUBSCRIBE', bytes: [0xa2, 6, 0, 1, 0, 0, 1, 0x61] },
  { command: 'PINGREQ', bytes: [0xc0, 0] },
] as const;

test.each(adapters.flatMap((adapter) => wrongDirection.map((vector) => ({ adapter, ...vector }))))(
  '$adapter rejects a broker $command and preserves only the valid wire prefix',
  async ({ adapter, command, bytes }: Readonly<{ adapter: Adapter; command: string; bytes: readonly number[] }>) => {
    const prefix = [0x30, 4, 0, 1, 0x61, 0];
    const suffix = [0x30, 4, 0, 1, 0x62, 0, 0xd0, 0];
    const reply = [...prefix, ...bytes, ...suffix];
    const onMessage = vi.fn<(message: Readonly<{ topic: string }>) => void>();
    const options = { clientId: 'packet-direction', onMessage, timeoutMs: 1000 };
    const peer =
      adapter === 'tcp' ? await startTcpPacketPeer('fixed-reply', reply) : await startWebSocketPacketPeer('fixed-reply', reply);
    try {
      const client = await (
        'host' in peer
          ? createTcpClient({ ...peer, ...options })
          : adapter === 'browser'
            ? createBrowserClient({ ...peer, ...options })
            : createWebSocketClient({ ...peer, ...options })
      ).connect();
      const failure = await client.ping().catch((reason: unknown) => reason);
      expect(failure).toMatchObject({ code: 0x82 });
      if (!(failure instanceof Error)) throw new Error('Expected a broker direction error');
      expect(failure.message).toContain(command);
      expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topic: 'a' }));
      await expect(client.ping()).rejects.toBe(failure);
      await expect.poll(() => peer.disconnectReasons).toEqual([0x82]);
    } finally {
      await peer.close();
    }
  },
);
