import { getEventListeners, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { afterEach, expect, test, vi } from 'vitest';
import { openBrowserTransport } from '../src/browserTransport.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('sends binary MQTT bytes and delivers binary replies over native WebSocket', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const onBytes = vi.fn();
  const onClose = vi.fn();
  try {
    const [transport, [peer]] = await Promise.all([
      openBrowserTransport('ws://127.0.0.1:' + address.port, { onBytes, onClose }),
      once(server, 'connection'),
    ]);
    const request = once(peer, 'message');
    transport.send(Uint8Array.of(0xc0, 0));
    await expect(request).resolves.toEqual([Buffer.from([0xc0, 0]), true]);
    peer.send(Uint8Array.of(0xd0, 0));
    await vi.waitFor(() => expect(onBytes).toHaveBeenCalledWith(Uint8Array.of(0xd0, 0)));
    await transport.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(() => transport.send(Uint8Array.of(0xc0, 0))).toThrow('closed');
  } finally {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

class Socket extends EventTarget {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instance: Socket;
  protocol = 'mqtt';
  readyState = 1;
  binaryType = 'blob';
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 2;
  });
  constructor() {
    super();
    Socket.instance = this;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
}

test('a throwing close observer rejects the close promise after native completion', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const reason = new Error('observer failed');
  const transport = await openBrowserTransport('ws://localhost', {
    onBytes: vi.fn(),
    onClose() {
      throw reason;
    },
  });
  let closing!: Promise<void>;
  expect(() => {
    closing = transport.close();
  }).not.toThrow();
  const result = expect(closing).rejects.toBe(reason);
  Socket.instance.readyState = Socket.CLOSED;
  Socket.instance.dispatchEvent(new Event('close'));
  await result;
  expect(getEventListeners(Socket.instance, 'close')).toEqual([]);
});

test('remote close still settles when its observer throws', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const reason = new Error('remote observer failed');
  const transport = await openBrowserTransport('ws://localhost', {
    onBytes: vi.fn(),
    onClose() {
      throw reason;
    },
  });
  Socket.instance.readyState = Socket.CLOSED;
  Socket.instance.dispatchEvent(new Event('close'));
  await expect(transport.close()).rejects.toBe(reason);
  expect(getEventListeners(Socket.instance, 'close')).toEqual([]);
});

test('rejects cancellation between native open and transport handoff', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled at handoff');
  class AbortingSocket extends Socket {
    constructor() {
      super();
      queueMicrotask(() => controller.abort(reason));
    }
  }
  vi.stubGlobal('WebSocket', AbortingSocket);
  await expect(
    openBrowserTransport('ws://localhost', {
      signal: controller.signal,
      onBytes: vi.fn(),
      onClose: vi.fn(),
    }),
  ).rejects.toBe(reason);
  Socket.instance.dispatchEvent(new Event('close'));
});

test('rejects a write above the remaining byte budget before native send', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const transport = await openBrowserTransport('ws://localhost', { onBytes: vi.fn(), onClose: vi.fn(), maxBufferedBytes: 4 });
  Socket.instance.bufferedAmount = 3;
  expect(() => transport.send(Uint8Array.of(1, 2))).toThrow('budget');
  expect(Socket.instance.send).not.toHaveBeenCalled();
  Socket.instance.dispatchEvent(new Event('close'));
});

test('abort retires delivery, removes listeners, and rejects later writes', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const controller = new AbortController();
  const onBytes = vi.fn();
  const onClose = vi.fn();
  const transport = await openBrowserTransport('ws://localhost', { signal: controller.signal, onBytes, onClose });
  const reason = new Error('cancelled session');
  const lateMessage = getEventListeners(Socket.instance, 'message')[0];
  controller.abort(reason);
  lateMessage.call(Socket.instance, new MessageEvent('message', { data: new ArrayBuffer(2) }));
  Socket.instance.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(2) }));
  expect(onBytes).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledExactlyOnceWith(reason);
  expect(() => transport.send(Uint8Array.of(1))).toThrow(reason);
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  expect(getEventListeners(Socket.instance, 'message')).toEqual([]);
  Socket.instance.dispatchEvent(new Event('close'));
});

test('rejects text frames and delivers no bytes', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const onBytes = vi.fn();
  const onClose = vi.fn();
  await openBrowserTransport('ws://localhost', { onBytes, onClose });
  Socket.instance.dispatchEvent(new MessageEvent('message', { data: 'not MQTT binary' }));
  expect(onBytes).not.toHaveBeenCalled();
  expect(onClose.mock.calls[0]?.[0].message).toContain('binary');
  expect(Socket.instance.close).toHaveBeenCalledTimes(1);
  Socket.instance.dispatchEvent(new Event('close'));
});

test('close is idempotent and reports a stalled native close at its deadline', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const onClose = vi.fn();
  const transport = await openBrowserTransport('ws://localhost', { onBytes: vi.fn(), onClose, timeoutMs: 50 });
  vi.useFakeTimers();
  const closing = transport.close();
  const result = expect(closing).rejects.toThrow('close timed out');
  expect(transport.close()).toBe(closing);
  await vi.advanceTimersByTimeAsync(50);
  await result;
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(getEventListeners(Socket.instance, 'close')).toEqual([]);
});
