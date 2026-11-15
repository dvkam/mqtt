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

// MQTT-2.2.1-3: a packet identifier is nonzero. Each adapter answers a zero one with DISCONNECT 0x82.
const zeroIdentifier = [
  { command: 'PUBACK', bytes: [0x40, 2, 0, 0] },
  { command: 'SUBACK', bytes: [0x90, 4, 0, 0, 0, 0] },
  { command: 'QoS 1 PUBLISH', bytes: [0x32, 6, 0, 1, 0x61, 0, 0, 0] },
] as const;

/** Send a valid PUBLISH, then `bytes`, then a valid PUBLISH and PINGRESP. Return the session's failure. The QoS 1 handler is set only when asked. */
async function failureAfter(adapter: Adapter, bytes: readonly number[], receiveQosOne = false) {
  const prefix = [0x30, 4, 0, 1, 0x61, 0];
  const suffix = [0x30, 4, 0, 1, 0x62, 0, 0xd0, 0];
  const reply = [...prefix, ...bytes, ...suffix];
  const onMessage = vi.fn<(message: Readonly<{ topic: string }>) => void>();
  const onQosOneMessage = vi.fn<(message: unknown) => void>();
  const options = { clientId: 'packet-direction', onMessage, ...(receiveQosOne ? { onQosOneMessage } : {}), timeoutMs: 1000 };
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
    if (!(failure instanceof Error)) throw new Error('Expected a protocol error');
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topic: 'a' }));
    expect(onQosOneMessage).not.toHaveBeenCalled();
    await expect(client.ping()).rejects.toBe(failure);
    await expect.poll(() => peer.disconnectReasons).toEqual([0x82]);
    return failure;
  } finally {
    await peer.close();
  }
}

test.each(adapters.flatMap((adapter) => wrongDirection.map((vector) => ({ adapter, ...vector }))))(
  '$adapter rejects a broker $command and preserves only the valid wire prefix',
  async ({ adapter, command, bytes }: Readonly<{ adapter: Adapter; command: string; bytes: readonly number[] }>) => {
    const failure = await failureAfter(adapter, bytes);
    expect(failure.message).toContain(command);
  },
);

test.each(adapters.flatMap((adapter) => zeroIdentifier.map((vector) => ({ adapter, ...vector }))))(
  '$adapter answers a $command with packet identifier 0 with DISCONNECT 0x82',
  async ({ adapter, bytes }: Readonly<{ adapter: Adapter; command: string; bytes: readonly number[] }>) => {
    const failure = await failureAfter(adapter, bytes, true);
    expect(failure.message).toBe('MQTT integer out of range');
  },
);
