import type { Packet } from 'mqtt-packet';
import { Socket } from 'node:net';
import { getEventListeners } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { connectPortable, type PacketTransport } from '../src/portable.js';
import { createTcpClient } from '../src/tcpClient.js';
import { createWebSocketClient } from '../src/websocketClient.js';
import { startCancellationPeer } from './experiments/node-cancellation-peer.js';

afterEach(() => {
  vi.useRealTimers();
});

function stalledPeer(closeMode: 'resolve' | 'reject' | 'pending' = 'resolve', throwUnlisten = false, holdConnect = false) {
  const commands: string[] = [];
  const writes: { resolve: () => void; reject: (reason: Readonly<Error>) => void }[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The transport retains the mutable packet callback contract.
  let receive: (packet: Packet) => void;
  const close = vi.fn<PacketTransport['close']>(async () => {
    if (closeMode === 'reject') throw new Error('close rejected');
    if (closeMode === 'pending') await new Promise(() => {});
  });
  const transport: PacketTransport = {
    listen(onPacket) {
      receive = onPacket;
      return () => {
        if (throwUnlisten) throw new Error('unlisten threw');
      };
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture accepts the packet transport's mutable packet union.
    async send(packet) {
      commands.push(packet.cmd);
      if (packet.cmd === 'connect' && !holdConnect) {
        receive({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
        return;
      }
      return new Promise<void>((resolve, reject) => {
        writes.push({ resolve, reject });
      });
    },
    close,
  };
  return {
    transport,
    commands,
    writes,
    close,
    acknowledge: () => {
      receive({ cmd: 'suback', messageId: 1, granted: [0] });
    },
  };
}

test.each(['resolve', 'reject', 'pending'] as const)(
  'timeout fences new writes before promise continuations when close will %s',
  async (mode) => {
    vi.useFakeTimers();
    const peer = stalledPeer(mode);
    const client = await connectPortable(peer.transport, { clientId: 'stalled', timeoutMs: 100 });
    const first = client.publish('a', 'one').catch((reason: unknown) => reason);
    const second = client.publish('b', 'two').catch((reason: unknown) => reason);
    const subscription = client.subscribe('c').catch((reason: unknown) => reason);
    vi.advanceTimersByTime(100);
    const retry = client.publish('a', 'retry').catch((reason: unknown) => reason);
    expect(peer.commands).toEqual(['connect', 'publish', 'publish', 'subscribe']);
    const reason = await first;
    expect(reason).toBeInstanceOf(Error);
    expect(reason).toMatchObject({ message: 'MQTT operation timed out' });
    await expect(second).resolves.toBe(reason);
    await expect(subscription).resolves.toBe(reason);
    await expect(retry).resolves.toBe(reason);
    expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
    peer.writes[0]!.resolve();
    peer.writes[1]!.reject(new Error('late write failure'));
    peer.writes[2]!.resolve();
    peer.acknowledge();
    await expect(client.ping()).rejects.toBe(reason);
    expect(peer.close).toHaveBeenCalledTimes(1);
  },
);

test('throwing unlisten cannot prevent the timeout forced-close request', async () => {
  vi.useFakeTimers();
  const peer = stalledPeer('reject', true);
  const client = await connectPortable(peer.transport, { clientId: 'cleanup-error', timeoutMs: 100 });
  const pending = client.publish('a', 'one').catch((reason: unknown) => reason);
  vi.advanceTimersByTime(100);
  const reason = await pending;
  expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
  await expect(client.publish('a', 'late')).rejects.toBe(reason);
});

test.each(['connect', 'disconnect'] as const)('%s timeout requests forced closure once across cleanup paths', async (kind) => {
  vi.useFakeTimers();
  const peer = stalledPeer('resolve', false, kind === 'connect');
  const opening = connectPortable(peer.transport, { clientId: 'cleanup-once', timeoutMs: 100 });
  const pending = (kind === 'connect' ? opening : (await opening).disconnect()).catch((reason: unknown) => reason);
  await Promise.resolve();
  vi.advanceTimersByTime(100);
  expect(await pending).toMatchObject({ message: 'MQTT operation timed out' });
  expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
});

test('a completed publication stays successful and clears its timeout', async () => {
  vi.useFakeTimers();
  const peer = stalledPeer();
  const client = await connectPortable(peer.transport, { clientId: 'completed', timeoutMs: 100 });
  const pending = client.publish('a', 'one');
  peer.writes[0]!.resolve();
  await pending;
  vi.advanceTimersByTime(100);
  expect(peer.close).not.toHaveBeenCalled();
  const next = client.publish('a', 'two');
  peer.writes[1]!.resolve();
  await next;
});

test('TCP publication timeout destroys a socket with a held write and fences immediate retry', async () => {
  const peer = await startCancellationPeer('tcp');
  const controller = new AbortController();
  const writes = vi.spyOn(Socket.prototype, 'write');
  let owner: Socket | undefined;
  let restore: (() => void) | undefined;
  try {
    const client = await createTcpClient({
      ...peer,
      clientId: 'held-timeout',
      timeoutMs: 1000,
      signal: controller.signal,
    }).connect();
    const connected: unknown = writes.mock.contexts.find(
      (candidate: unknown) => candidate instanceof Socket && candidate.remotePort === peer.port,
    );
    writes.mockRestore();
    if (!(connected instanceof Socket)) throw new Error('Expected connected client socket');
    owner = connected;
    const blocked = vi.spyOn(owner, '_write').mockImplementation(() => {});
    restore = () => {
      blocked.mockRestore();
    };
    vi.useFakeTimers();
    const pending = client.publish('a', 'blocked').catch((reason: unknown) => reason);
    expect(owner.writableLength).toBeGreaterThan(0);
    vi.advanceTimersByTime(1000);
    const retry = client.publish('a', 'retry').catch((reason: unknown) => reason);
    const reason = await pending;
    expect(reason).toMatchObject({ message: 'MQTT operation timed out' });
    expect(owner.destroyed).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    await expect(retry).resolves.toBe(reason);
    await peer.peerClosed;
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(peer.commands).toEqual(['connect']);
  } finally {
    vi.useRealTimers();
    writes.mockRestore();
    restore?.();
    owner?.destroy();
    await peer.close();
  }
});

test.each(['tcp', 'websocket'] as const)('%s timeout releases cancellation before waiting for native close', async (kind) => {
  const peer = await startCancellationPeer(kind);
  const controller = new AbortController();
  try {
    const options = { ...peer, clientId: 'timeout-cleanup', timeoutMs: 1000, signal: controller.signal };
    const client = await (kind === 'tcp' ? createTcpClient(options) : createWebSocketClient(options)).connect();
    vi.useFakeTimers();
    const pending = client.ping().catch((reason: unknown) => reason);
    vi.advanceTimersByTime(1000);
    const reason = await pending;
    expect(reason).toMatchObject({ message: 'MQTT operation timed out' });
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    controller.abort(new Error('late abort'));
    await expect(client.publish('a', 'late')).rejects.toBe(reason);
    await peer.peerClosed;
  } finally {
    vi.useRealTimers();
    await peer.close();
  }
});

test('a timed-out ping rejects while forced transport close remains pending', async () => {
  vi.useFakeTimers();
  const peer = stalledPeer('pending');
  const client = await connectPortable(peer.transport, { clientId: 'ping-timeout', timeoutMs: 100 });
  const ping = client.ping().catch((error: unknown) => error);
  vi.advanceTimersByTime(100);
  const reason = await ping;
  expect(reason).toMatchObject({ message: 'MQTT operation timed out' });
  expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
  await expect(client.ping()).rejects.toBe(reason);
  peer.writes[0]?.resolve();
}, 500);
