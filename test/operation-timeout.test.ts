import type { ReceivedPacket } from '../src/portable.js';
import { Socket } from 'node:net';
import { getEventListeners } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { connectPortable, type PacketTransport } from '../src/portable.js';
import { createTcpClient } from '../src/tcpClient.js';
import { createWebSocketClient } from '../src/websocketClient.js';
import { startCancellationPeer } from './experiments/node-cancellation-peer.js';
import type { ClientPacket } from '../src/wireCodec.js';
import type { ReadonlyDeep } from '../src/util/bytes.js';
import { entryAt } from './experiments/entry.js';

afterEach(() => {
  vi.useRealTimers();
});

function stalledPeer(closeMode: 'resolve' | 'reject' | 'pending' = 'resolve', throwUnlisten = false, holdConnect = false) {
  const commands: string[] = [];
  const writes: { resolve: () => void; reject: (reason: Readonly<Error>) => void }[] = [];
  let receive: (packet: ReadonlyDeep<ReceivedPacket>) => void;
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
    async send(packet: ReadonlyDeep<ClientPacket>) {
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
    expect(reason).toMatchObject({ message: 'MQTT operation timed out', code: 'ERR_MQTT_TIMEOUT', fatal: true });
    await expect(second).resolves.toBe(reason);
    await expect(subscription).resolves.toBe(reason);
    await expect(retry).resolves.toBe(reason);
    expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
    entryAt(peer.writes, 0).resolve();
    entryAt(peer.writes, 1).reject(new Error('late write failure'));
    entryAt(peer.writes, 2).resolve();
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
  expect(await pending).toMatchObject({ message: 'MQTT operation timed out', code: 'ERR_MQTT_TIMEOUT', fatal: true });
  expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
});

test('a completed publication stays successful and clears its timeout', async () => {
  vi.useFakeTimers();
  const peer = stalledPeer();
  const client = await connectPortable(peer.transport, { clientId: 'completed', timeoutMs: 100 });
  const pending = client.publish('a', 'one');
  entryAt(peer.writes, 0).resolve();
  await pending;
  vi.advanceTimersByTime(100);
  expect(peer.close).not.toHaveBeenCalled();
  const next = client.publish('a', 'two');
  entryAt(peer.writes, 1).resolve();
  await next;
});

test('sequential QoS 0 writes share a timer and a later stalled write keeps its own deadline', async () => {
  vi.useFakeTimers();
  const peer = stalledPeer();
  const client = await connectPortable(peer.transport, { clientId: 'publish-deadlines', timeoutMs: 100 });
  const schedule = vi.spyOn(globalThis, 'setTimeout');
  try {
    for (let index = 0; index < 1000; index++) {
      const published = client.publish('a', 'ready');
      entryAt(peer.writes, -1).resolve();
      await published;
    }
    expect(schedule.mock.calls.length).toBeLessThanOrEqual(1);
    vi.advanceTimersByTime(60);
    const stalled = client.publish('a', 'stalled').catch((reason: unknown) => reason);
    vi.advanceTimersByTime(99);
    expect(peer.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    const reason = await stalled;
    expect(reason).toMatchObject({ message: 'MQTT operation timed out', code: 'ERR_MQTT_TIMEOUT', fatal: true });
    expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(client.publish('a', 'later')).rejects.toBe(reason);
  } finally {
    schedule.mockRestore();
  }
});

test('an expired QoS 0 write retires a later write that completes before the shared timer wakes', async () => {
  vi.useFakeTimers();
  const peer = stalledPeer();
  const client = await connectPortable(peer.transport, { clientId: 'rounded-deadlines', timeoutMs: 100 });
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    const first = client.publish('a', 'ready');
    entryAt(peer.writes, 0).resolve();
    await first;
    await vi.advanceTimersByTimeAsync(60);
    now.mockReturnValue(60.25);
    const stalled = client.publish('a', 'stalled').catch((reason: unknown) => reason);
    now.mockReturnValue(100.1);
    await vi.advanceTimersByTimeAsync(40);
    const later = client.publish('a', 'completes').catch((reason: unknown) => reason);
    now.mockReturnValue(160.5);
    entryAt(peer.writes, 2).resolve();
    const reason = await later;
    expect(reason).toMatchObject({ message: 'MQTT operation timed out', code: 'ERR_MQTT_TIMEOUT', fatal: true });
    await expect(stalled).resolves.toBe(reason);
    expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    now.mockRestore();
  }
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
    expect(reason).toMatchObject({ message: 'MQTT operation timed out', code: 'ERR_MQTT_TIMEOUT', fatal: true });
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
    expect(reason).toMatchObject({ message: 'MQTT operation timed out', code: 'ERR_MQTT_TIMEOUT', fatal: true });
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
  expect(reason).toMatchObject({ message: 'MQTT operation timed out', code: 'ERR_MQTT_TIMEOUT', fatal: true });
  expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
  await expect(client.ping()).rejects.toBe(reason);
  peer.writes[0]?.resolve();
}, 500);
