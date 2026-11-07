import { getEventListeners, once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { expect, test, vi } from 'vitest';
import { openMqttWebSocket } from '../src/websocket.js';

async function peer(selectProtocol = true) {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: false,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    handleProtocols: (protocols) => (selectProtocol && protocols.has('mqtt') ? 'mqtt' : false),
  });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  return {
    server,
    url: 'ws://127.0.0.1:' + address.port,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

test('negotiates MQTT and exchanges binary frames through native WebSocket', async () => {
  const broker = await peer();
  try {
    const [client, acceptedArguments] = await Promise.all([openMqttWebSocket(broker.url), once(broker.server, 'connection')]);
    const socketArguments: unknown[] = acceptedArguments;
    const [socket] = socketArguments;
    if (!(socket instanceof WebSocket)) throw new Error('Expected WebSocket peer');
    expect(client.protocol).toBe('mqtt');
    expect(client.binaryType).toBe('arraybuffer');
    const received = once(socket, 'message');
    client.send(Uint8Array.of(0xc0, 0));
    await expect(received).resolves.toEqual([Buffer.from([0xc0, 0]), true]);

    const response = once(client, 'message');
    socket.send(Uint8Array.of(0xd0, 0));
    const responseArguments: unknown[] = await response;
    const [message] = responseArguments;
    if (!(message instanceof MessageEvent)) throw new Error('Expected message event');
    const data: unknown = message.data;
    if (!(data instanceof ArrayBuffer)) throw new Error('Expected binary frame');
    expect(new Uint8Array(data)).toEqual(Uint8Array.of(0xd0, 0));

    const closed = once(client, 'close');
    socket.close(1000);
    await closed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
  } finally {
    await broker.close();
  }
});

test('rejects an opening handshake without the MQTT subprotocol', async () => {
  const broker = await peer(false);
  try {
    await expect(openMqttWebSocket(broker.url)).rejects.toThrow('MQTT WebSocket');
  } finally {
    await broker.close();
  }
});

test('rejects an already-aborted signal without opening a connection', async () => {
  const broker = await peer();
  try {
    const reason = new Error('cancelled before opening');
    const controller = new AbortController();
    controller.abort(reason);
    await expect(openMqttWebSocket(broker.url, { signal: controller.signal })).rejects.toBe(reason);
    expect(broker.server.clients.size).toBe(0);
  } finally {
    await broker.close();
  }
});

class TestSocket extends EventTarget {
  static CLOSING = 2;
  static instance: TestSocket;
  protocol = 'mqtt';
  binaryType = 'blob';
  readyState = 0;
  closeCalls = 0;
  constructor() {
    super();
    TestSocket.instance = this;
  }
  close() {
    this.closeCalls++;
    this.readyState = TestSocket.CLOSING;
    this.dispatchEvent(new Event('close'));
  }
}

test('cancels an in-flight handshake and removes its open listener before a late event', async () => {
  const controller = new AbortController();
  const reason = new Error('handshake cancelled');
  vi.stubGlobal('WebSocket', TestSocket);
  try {
    const opening = openMqttWebSocket('ws://127.0.0.1', { signal: controller.signal });
    const result = (async () => {
      await expect(opening).rejects.toBe(reason);
    })();
    controller.abort(reason);
    const socket = TestSocket.instance;
    await result;
    expect(getEventListeners(socket, 'open')).toEqual([]);
    socket.dispatchEvent(new Event('open'));
    expect(socket.closeCalls).toBe(1);
    expect(getEventListeners(socket, 'open')).toEqual([]);
    expect(getEventListeners(socket, 'error')).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('times out a stalled opening and leaves no handshake listeners', async () => {
  vi.stubGlobal('WebSocket', TestSocket);
  vi.useFakeTimers();
  try {
    const opening = openMqttWebSocket('ws://127.0.0.1', { timeoutMs: 50 });
    const result = (async () => {
      await expect(opening).rejects.toThrow('handshake timed out');
    })();
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(TestSocket.instance.closeCalls).toBe(1);
    expect(getEventListeners(TestSocket.instance, 'open')).toEqual([]);
    expect(getEventListeners(TestSocket.instance, 'close')).toEqual([]);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
