import { getEventListeners, once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
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
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  const onBytes = vi.fn<(bytes: Readonly<{ byteLength: number }>) => void>();
  const onClose = vi.fn<(reason: Readonly<Error>) => void>();
  try {
    const [transport, acceptedArguments] = await Promise.all([
      openBrowserTransport('ws://127.0.0.1:' + address.port, { onBytes, onClose }),
      once(server, 'connection'),
    ]);
    const peerArguments: unknown[] = acceptedArguments;
    const [peer] = peerArguments;
    if (!(peer instanceof WebSocket)) throw new Error('Expected WebSocket peer');
    const request = once(peer, 'message');
    transport.send(Uint8Array.of(0xc0, 0));
    await expect(request).resolves.toEqual([Buffer.from([0xc0, 0]), true]);
    peer.send(Uint8Array.of(0xd0, 0));
    await vi.waitFor(() => {
      expect(onBytes).toHaveBeenCalledWith(Uint8Array.of(0xd0, 0));
    });
    await transport.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(() => {
      transport.send(Uint8Array.of(0xc0, 0));
    }).toThrow('closed');
  } finally {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
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
  send = vi.fn<(data: unknown) => void>();
  close = vi.fn<() => void>(() => {
    this.readyState = 2;
  });
  constructor() {
    super();
    Socket.instance = this;
    queueMicrotask(() => {
      this.dispatchEvent(new Event('open'));
    });
  }
}

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
  'rejects receive capacity %s before opening',
  async (capacity) => {
    const constructing = vi.fn<() => never>(() => {
      throw new Error('Unexpected WebSocket opening');
    });
    vi.stubGlobal('WebSocket', constructing);
    await expect(
      openBrowserTransport('ws://localhost', {
        maxWebSocketMessageBytes: capacity,
        onBytes() {},
        onClose() {},
      }),
    ).rejects.toThrow(RangeError);
    expect(constructing).not.toHaveBeenCalled();
  },
);

test('admits the exact aggregate limit and empty binary messages', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const received: number[][] = [];
  const transport = await openBrowserTransport('ws://localhost', {
    maxWebSocketMessageBytes: 4,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The callback receives the transport's native mutable byte view.
    onBytes(bytes) {
      received.push([...bytes]);
    },
    onClose() {},
  });
  Socket.instance.dispatchEvent(new MessageEvent('message', { data: Uint8Array.of(0xd0, 0, 0xd0, 0).buffer }));
  Socket.instance.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer() }));
  expect(received).toEqual([[0xd0, 0, 0xd0, 0], []]);
  const closing = transport.close();
  Socket.instance.dispatchEvent(new Event('close'));
  await closing;
});

test.each([1, 2_147_483_647])('accepts supported receive capacity %s', async (capacity) => {
  vi.stubGlobal('WebSocket', Socket);
  const onBytes = vi.fn<(bytes: unknown) => void>();
  const transport = await openBrowserTransport('ws://localhost', { maxWebSocketMessageBytes: capacity, onBytes, onClose() {} });
  Socket.instance.dispatchEvent(new MessageEvent('message', { data: Uint8Array.of(0).buffer }));
  expect(onBytes).toHaveBeenCalledExactlyOnceWith(Uint8Array.of(0));
  const closing = transport.close();
  Socket.instance.dispatchEvent(new Event('close'));
  await closing;
});

test('rejects excess before byte delivery and preserves the first failure against late events', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const onBytes = vi.fn<(bytes: unknown) => void>();
  const onClose = vi.fn<(reason: unknown, kind: unknown) => void>();
  const controller = new AbortController();
  const transport = await openBrowserTransport('ws://localhost', {
    maxWebSocketMessageBytes: 4,
    onBytes,
    onClose,
    signal: controller.signal,
  });
  const captured = getEventListeners(Socket.instance, 'message')[0];
  if (captured === undefined) throw new Error('Expected message callback');
  Socket.instance.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(5) }));
  expect(onBytes).not.toHaveBeenCalled();
  const failure: unknown = onClose.mock.calls[0]?.[0];
  expect(failure).toBeInstanceOf(RangeError);
  expect(failure).toMatchObject({ message: 'WebSocket receive message limit exceeded' });
  expect(onClose.mock.calls[0]?.[1]).toBe('error');
  expect(Socket.instance.close).toHaveBeenCalledTimes(1);
  captured.call(Socket.instance, new MessageEvent('message', { data: Uint8Array.of(0xd0, 0).buffer }));
  Socket.instance.dispatchEvent(new Event('error'));
  controller.abort(new Error('later abort'));
  Socket.instance.dispatchEvent(new Event('close'));
  await transport.close();
  expect(onBytes).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(getEventListeners(Socket.instance, 'message')).toEqual([]);
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  expect(() => {
    transport.send(Uint8Array.of(0xc0, 0));
  }).toThrow(failure);
});

test('the default rejects a message above one MiB before byte delivery', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const onBytes = vi.fn<(bytes: unknown) => void>();
  const onClose = vi.fn<(reason: unknown, kind: unknown) => void>();
  const transport = await openBrowserTransport('ws://localhost', { onBytes, onClose });
  Socket.instance.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(1024 * 1024) }));
  expect(onBytes).toHaveBeenCalledTimes(1);
  onBytes.mockClear();
  Socket.instance.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(1024 * 1024 + 1) }));
  expect(onBytes).not.toHaveBeenCalled();
  expect(onClose.mock.calls[0]?.[0]).toBeInstanceOf(RangeError);
  Socket.instance.dispatchEvent(new Event('close'));
  await transport.close();
});

test.each(['remote', 'local', 'abort', 'error'] as const)('reports the first %s retirement kind exactly once', async (kind) => {
  vi.stubGlobal('WebSocket', Socket);
  const controller = new AbortController();
  const onClose = vi.fn<(reason: unknown, kind: unknown) => void>();
  const transport = await openBrowserTransport('ws://localhost', { signal: controller.signal, onBytes() {}, onClose });
  const reason = new Error('explicit cancellation');
  let closing: Promise<void> | undefined;
  if (kind === 'local') closing = transport.close();
  if (kind === 'abort') controller.abort(reason);
  if (kind === 'error') Socket.instance.dispatchEvent(new Event('error'));
  Socket.instance.readyState = Socket.CLOSED;
  Socket.instance.dispatchEvent(new Event('close'));
  await (closing ?? transport.close());
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onClose.mock.calls[0]?.[1]).toBe(kind);
  expect(onClose.mock.calls[0]?.[0]).toBeInstanceOf(Error);
});

test('a throwing close observer rejects the close promise after native completion', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const reason = new Error('observer failed');
  const transport = await openBrowserTransport('ws://localhost', {
    onBytes: vi.fn<(bytes: Readonly<{ byteLength: number }>) => void>(),
    onClose() {
      throw reason;
    },
  });
  let closing!: Promise<void>;
  expect(() => {
    closing = transport.close();
  }).not.toThrow();
  const result = (async () => {
    await expect(closing).rejects.toBe(reason);
  })();
  Socket.instance.readyState = Socket.CLOSED;
  Socket.instance.dispatchEvent(new Event('close'));
  await result;
  expect(getEventListeners(Socket.instance, 'close')).toEqual([]);
});

test('remote close still settles when its observer throws', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const reason = new Error('remote observer failed');
  const transport = await openBrowserTransport('ws://localhost', {
    onBytes: vi.fn<(bytes: Readonly<{ byteLength: number }>) => void>(),
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
      queueMicrotask(() => {
        controller.abort(reason);
      });
    }
  }
  vi.stubGlobal('WebSocket', AbortingSocket);
  await expect(
    openBrowserTransport('ws://localhost', {
      signal: controller.signal,
      onBytes: vi.fn<(bytes: Readonly<{ byteLength: number }>) => void>(),
      onClose: vi.fn<(reason: Readonly<Error>) => void>(),
    }),
  ).rejects.toBe(reason);
  Socket.instance.dispatchEvent(new Event('close'));
});

test('rejects a write above the remaining byte budget before native send', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const transport = await openBrowserTransport('ws://localhost', {
    onBytes: vi.fn<(bytes: Readonly<{ byteLength: number }>) => void>(),
    onClose: vi.fn<(reason: Readonly<Error>) => void>(),
    maxBufferedBytes: 4,
  });
  Socket.instance.bufferedAmount = 3;
  expect(() => {
    transport.send(Uint8Array.of(1, 2));
  }).toThrow('budget');
  expect(Socket.instance.send).not.toHaveBeenCalled();
  Socket.instance.dispatchEvent(new Event('close'));
});

test('abort retires delivery, removes listeners, and rejects later writes', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const controller = new AbortController();
  const onBytes = vi.fn<(bytes: Readonly<{ byteLength: number }>) => void>();
  const onClose = vi.fn<(reason: Readonly<Error>) => void>();
  const transport = await openBrowserTransport('ws://localhost', { signal: controller.signal, onBytes, onClose });
  const reason = new Error('cancelled session');
  const lateMessage = getEventListeners(Socket.instance, 'message')[0];
  controller.abort(reason);
  if (lateMessage === undefined) throw new Error('Expected installed message listener');
  lateMessage.call(Socket.instance, new MessageEvent('message', { data: new ArrayBuffer(2) }));
  Socket.instance.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(2) }));
  expect(onBytes).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledExactlyOnceWith(reason, 'abort');
  expect(() => {
    transport.send(Uint8Array.of(1));
  }).toThrow(reason);
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  expect(getEventListeners(Socket.instance, 'message')).toEqual([]);
  Socket.instance.dispatchEvent(new Event('close'));
});

test('rejects text frames and delivers no bytes', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const onBytes = vi.fn<(bytes: Readonly<{ byteLength: number }>) => void>();
  const onClose = vi.fn<(reason: Readonly<Error>) => void>();
  await openBrowserTransport('ws://localhost', { onBytes, onClose });
  Socket.instance.dispatchEvent(new MessageEvent('message', { data: 'not MQTT binary' }));
  expect(onBytes).not.toHaveBeenCalled();
  expect(onClose.mock.calls[0]?.[0]?.message).toContain('binary');
  expect(Socket.instance.close).toHaveBeenCalledTimes(1);
  Socket.instance.dispatchEvent(new Event('close'));
});

test('close is idempotent and reports a stalled native close at its deadline', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const onClose = vi.fn<(reason: Readonly<Error>) => void>();
  const transport = await openBrowserTransport('ws://localhost', {
    onBytes: vi.fn<(bytes: Readonly<{ byteLength: number }>) => void>(),
    onClose,
    timeoutMs: 50,
  });
  vi.useFakeTimers();
  const closing = transport.close();
  const result = (async () => {
    await expect(closing).rejects.toThrow('close timed out');
  })();
  expect(transport.close()).toBe(closing);
  await vi.advanceTimersByTimeAsync(50);
  await result;
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(getEventListeners(Socket.instance, 'close')).toEqual([]);
});

test('raw browser writes preserve the full budget unless classified as publication', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const transport = await openBrowserTransport('ws://unused', {
    maxBufferedBytes: 8,
    reservedControlBytes: 3,
    onBytes() {},
    onClose() {},
  });
  transport.send(new Uint8Array(8));
  expect(() => {
    transport.send(new Uint8Array(6), 'publication');
  }).toThrow('budget');
  transport.send(new Uint8Array(5), 'publication');
  Socket.instance.bufferedAmount = 5;
  transport.send(new Uint8Array(3), 'control');
  expect(() => {
    transport.send(Uint8Array.of(0), 'publication');
  }).toThrow('budget');
  Socket.instance.bufferedAmount = 8;
  expect(() => {
    transport.send(Uint8Array.of(0), 'control');
  }).toThrow('budget');
  expect(Socket.instance.send).toHaveBeenCalledTimes(3);
  const closing = transport.close();
  Socket.instance.readyState = Socket.CLOSED;
  Socket.instance.dispatchEvent(new Event('close'));
  await closing;
});

test.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid native bufferedAmount %s', async (queued) => {
  vi.stubGlobal('WebSocket', Socket);
  const transport = await openBrowserTransport('ws://unused', { onBytes() {}, onClose() {} });
  Socket.instance.bufferedAmount = queued;
  expect(() => {
    transport.send(Uint8Array.of(0xc0, 0));
  }).toThrow('budget');
  expect(Socket.instance.send).not.toHaveBeenCalled();
  const closing = transport.close();
  Socket.instance.readyState = Socket.CLOSED;
  Socket.instance.dispatchEvent(new Event('close'));
  await closing;
});

test.each([
  [1, undefined, 1],
  [2, undefined, 2],
  [3, undefined, 3],
  [4, undefined, 3],
  [8, 0, 8],
  [8, 8, 0],
] as const)(
  'uses total %s and reserve %s for raw publication capacity',
  async (maxBufferedBytes, reservedControlBytes, ceiling) => {
    vi.stubGlobal('WebSocket', Socket);
    const transport = await openBrowserTransport('ws://unused', {
      maxBufferedBytes,
      reservedControlBytes,
      onBytes() {},
      onClose() {},
    });
    transport.send(new Uint8Array(ceiling), 'publication');
    expect(() => {
      transport.send(new Uint8Array(ceiling + 1), 'publication');
    }).toThrow('budget');
    transport.send(new Uint8Array(maxBufferedBytes), 'control');
    const closing = transport.close();
    Socket.instance.readyState = Socket.CLOSED;
    Socket.instance.dispatchEvent(new Event('close'));
    await closing;
  },
);

test('established browser failure wins over a later invalid native counter', async () => {
  vi.stubGlobal('WebSocket', Socket);
  const transport = await openBrowserTransport('ws://unused', { onBytes() {}, onClose() {} });
  Socket.instance.dispatchEvent(new Event('error'));
  Socket.instance.bufferedAmount = NaN;
  expect(() => {
    transport.send(Uint8Array.of(0xc0, 0), 'control');
  }).toThrow('MQTT WebSocket failed');
  const closing = transport.close();
  Socket.instance.readyState = Socket.CLOSED;
  Socket.instance.dispatchEvent(new Event('close'));
  await closing;
});
