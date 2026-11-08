import { afterEach, expect, test, vi } from 'vitest';
import type { Packet } from 'mqtt-packet';
import { createTcpClient } from '../src/tcpClient.js';
import { connectPortable, type PacketTransport } from '../src/portable.js';
import { createWebSocketClient } from '../src/websocketClient.js';
import { openMqttWebSocket } from '../src/websocket.js';
import { startCancellationPeer } from './experiments/node-cancellation-peer.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const invalidTimeouts = [0, -1, 0.5, 1.5, Number.NaN, Infinity, -Infinity, 2_147_483_648];

test.each(['tcp', 'websocket'] as const)('%s retains its deadline across transport-to-session handoff', async (kind) => {
  const peer = await startCancellationPeer(kind);
  const options = { ...peer, clientId: 'stable-opening', timeoutMs: 3000, maxPendingPublishes: 1, maxPendingPublishBytes: 128 };
  try {
    const opening = (kind === 'tcp' ? createTcpClient(options) : createWebSocketClient(options)).connect();
    options.timeoutMs = Infinity;
    options.maxPendingPublishes = 0;
    options.maxPendingPublishBytes = 0;
    const client = await opening;
    await client.publish('a', 'hello');
    await client.disconnect();
    await peer.peerClosed;
    expect(peer.commands).toEqual(['connect', 'publish', 'disconnect']);
  } finally {
    await peer.close();
  }
});

test.each(invalidTimeouts)('rejects TCP timeout %s before endpoint access', async (timeoutMs) => {
  const endpoint = vi.fn<() => never>(() => {
    throw new Error('endpoint accessed');
  });
  const factory = createTcpClient({
    clientId: 'invalid-timeout',
    timeoutMs,
    get host(): string {
      return endpoint();
    },
  });
  expect(endpoint).not.toHaveBeenCalled();
  await expect(factory.connect()).rejects.toBeInstanceOf(RangeError);
  expect(endpoint).not.toHaveBeenCalled();
});

test.each(invalidTimeouts)('rejects custom transport timeout %s before registration', async (timeoutMs) => {
  const listen = vi.fn<() => never>(() => {
    throw new Error('transport registered');
  });
  const send = vi.fn<() => Promise<void>>(async () => {});
  const close = vi.fn<() => Promise<void>>(async () => {});
  const transport: PacketTransport = { listen, send, close };
  await expect(connectPortable(transport, { clientId: 'invalid-timeout', timeoutMs })).rejects.toBeInstanceOf(RangeError);
  expect(listen).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

test('pre-aborted TCP keeps its original reason ahead of invalid timeout', async () => {
  const reason = new Error('already aborted');
  const factory = createTcpClient({ clientId: 'aborted', host: 'unused', timeoutMs: Infinity, signal: AbortSignal.abort(reason) });
  await expect(factory.connect()).rejects.toBe(reason);
});

test.each(invalidTimeouts)('rejects native WebSocket timeout %s before construction', async (timeoutMs) => {
  const construct = vi.fn<() => never>(() => {
    throw new Error('socket constructed');
  });
  vi.stubGlobal('WebSocket', construct);
  await expect(openMqttWebSocket('ws://unused', { timeoutMs })).rejects.toBeInstanceOf(RangeError);
  expect(construct).not.toHaveBeenCalled();
});

test.each(invalidTimeouts)('rejects Node WebSocket timeout %s before endpoint access', async (timeoutMs) => {
  const endpoint = vi.fn<() => never>(() => {
    throw new Error('endpoint accessed');
  });
  const factory = createWebSocketClient({
    clientId: 'invalid-timeout',
    timeoutMs,
    get url(): string {
      return endpoint();
    },
  });
  await expect(factory.connect()).rejects.toBeInstanceOf(RangeError);
  expect(endpoint).not.toHaveBeenCalled();
});

test.each([1, 3000, 2_147_483_647])('uses validated timeout %s for the active session after caller mutation', async (timeoutMs) => {
  vi.useFakeTimers();
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The injected transport retains the mutable packet callback contract.
  let receive: (packet: Packet) => void;
  const transport: PacketTransport = {
    listen(onPacket) {
      receive = onPacket;
      return () => {};
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The transport supplies its acknowledgment synchronously through the callback contract.
    async send(packet) {
      if (packet.cmd === 'connect') receive({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
    },
    async close() {},
  };
  const options = { clientId: 'stable-timeout', timeoutMs, maxPendingPublishes: 1, maxPendingPublishBytes: 128 };
  const client = await connectPortable(transport, options);
  options.timeoutMs = Infinity;
  options.maxPendingPublishes = 0;
  options.maxPendingPublishBytes = 0;
  const timer = vi.spyOn(globalThis, 'setTimeout');
  await client.publish('valid', 'message');
  expect(timer).toHaveBeenCalledWith(expect.any(Function), timeoutMs);
  await client.disconnect();
});
