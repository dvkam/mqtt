import { getEventListeners, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { afterEach, expect, test, vi } from 'vitest';
import { createBrowserClient } from '../src/browserClient.js';
import { PacketDecoder } from '../src/codec.js';

class ScriptedSocket extends EventTarget {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instance: ScriptedSocket;
  static connectBytes: readonly number[] = [0x20, 3, 0, 0, 0];
  static closeAfterConnect = false;
  static stallClose = false;
  protocol = 'mqtt';
  readyState = 1;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  constructor() {
    super();
    ScriptedSocket.instance = this;
    queueMicrotask(() => {
      this.dispatchEvent(new Event('open'));
    });
  }
  send(bytes: Readonly<{ [index: number]: unknown }>) {
    if (bytes[0] === 0x10)
      queueMicrotask(() => {
        this.receive(ScriptedSocket.connectBytes);
        if (ScriptedSocket.closeAfterConnect) this.remoteClose();
      });
  }
  receive(bytes: readonly number[]) {
    this.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from(bytes).buffer }));
  }
  remoteClose() {
    this.readyState = ScriptedSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
  close() {
    this.readyState = ScriptedSocket.CLOSING;
    if (!ScriptedSocket.stallClose)
      queueMicrotask(() => {
        this.remoteClose();
      });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  ScriptedSocket.connectBytes = [0x20, 3, 0, 0, 0];
  ScriptedSocket.closeAfterConnect = false;
  ScriptedSocket.stallClose = false;
});

test.each([[0x20], [0x20, 3, 0]])('remote EOF rejects a truncated CONNACK %j', async (...bytes: readonly number[]) => {
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const finish = vi.spyOn(PacketDecoder.prototype, 'finish');
  ScriptedSocket.connectBytes = bytes;
  ScriptedSocket.closeAfterConnect = true;
  await expect(createBrowserClient({ url: 'ws://localhost', clientId: 'partial-connect' }).connect()).rejects.toThrow(
    'Truncated MQTT',
  );
  expect(finish).toHaveBeenCalledTimes(1);
  expect(getEventListeners(ScriptedSocket.instance, 'message')).toEqual([]);
});

test('remote EOF rejects a pending ping with truncation and retires later writes', async () => {
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const finish = vi.spyOn(PacketDecoder.prototype, 'finish');
  const client = await createBrowserClient({ url: 'ws://localhost', clientId: 'partial-ping' }).connect();
  const pending = client.ping();
  const rejected = pending.catch((error: unknown) => error);
  ScriptedSocket.instance.receive([0xd0]);
  ScriptedSocket.instance.remoteClose();
  await expect(rejected).resolves.toMatchObject({ message: 'Truncated MQTT packet at end of input' });
  await expect(client.publish('a', 'late')).rejects.toThrow('Truncated MQTT');
  ScriptedSocket.instance.remoteClose();
  expect(finish).toHaveBeenCalledTimes(1);
});

test('clean remote EOF retains the transport close reason', async () => {
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const finish = vi.spyOn(PacketDecoder.prototype, 'finish');
  const client = await createBrowserClient({ url: 'ws://localhost', clientId: 'clean-end' }).connect();
  const rejected = client.ping().catch((error: unknown) => error);
  ScriptedSocket.instance.remoteClose();
  await expect(rejected).resolves.toMatchObject({ message: 'MQTT WebSocket closed' });
  expect(finish).toHaveBeenCalledTimes(1);
});

test('abort keeps its exact reason despite partial input and captured late events', async () => {
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const finish = vi.spyOn(PacketDecoder.prototype, 'finish');
  const controller = new AbortController();
  const onMessage = vi.fn<(message: unknown) => void>();
  const client = await createBrowserClient({
    url: 'ws://localhost',
    clientId: 'abort-partial',
    signal: controller.signal,
    onMessage,
  }).connect();
  const reason = new Error('cancel partial input');
  const rejected = client.ping().catch((error: unknown) => error);
  ScriptedSocket.instance.receive([0x30]);
  const late = getEventListeners(ScriptedSocket.instance, 'message')[0];
  if (late === undefined) throw new Error('Expected message listener');
  controller.abort(reason);
  late.call(ScriptedSocket.instance, new MessageEvent('message', { data: Uint8Array.of(0xd0, 0).buffer }));
  await expect(rejected).resolves.toBe(reason);
  await expect(client.publish('a', 'late')).rejects.toBe(reason);
  expect(onMessage).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledTimes(1);
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
});

test('graceful local disconnect succeeds while discarding partial input', async () => {
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const finish = vi.spyOn(PacketDecoder.prototype, 'finish');
  const client = await createBrowserClient({ url: 'ws://localhost', clientId: 'local-partial' }).connect();
  ScriptedSocket.instance.receive([0x30]);
  await expect(client.disconnect()).resolves.toBeUndefined();
  expect(finish).toHaveBeenCalledTimes(1);
});

test('refusal keeps its code when trailing input is incomplete', async () => {
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const finish = vi.spyOn(PacketDecoder.prototype, 'finish');
  ScriptedSocket.connectBytes = [0x20, 3, 0, 0x87, 0, 0x30];
  await expect(createBrowserClient({ url: 'ws://localhost', clientId: 'refused-partial' }).connect()).rejects.toMatchObject({
    code: 0x87,
  });
  expect(finish).toHaveBeenCalledTimes(1);
});

test('application callback failure wins over trailing truncation', async () => {
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const finish = vi.spyOn(PacketDecoder.prototype, 'finish');
  const reason = new Error('application failed');
  const client = await createBrowserClient({
    url: 'ws://localhost',
    clientId: 'observer-partial',
    onMessage() {
      throw reason;
    },
  }).connect();
  const rejected = client.ping().catch((error: unknown) => error);
  ScriptedSocket.instance.receive([0x30, 5, 0, 1, 0x61, 0, 0x62, 0x30]);
  await expect(rejected).resolves.toBe(reason);
  expect(finish).toHaveBeenCalledTimes(1);
});

test('prior decoder failure keeps its identity during completion', async () => {
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const finish = vi.spyOn(PacketDecoder.prototype, 'finish');
  const client = await createBrowserClient({ url: 'ws://localhost', clientId: 'decode-error' }).connect();
  const result = client.ping().catch((error: unknown) => error);
  ScriptedSocket.instance.receive([0xff]);
  const failure: unknown = await result;
  expect(failure).toBeInstanceOf(Error);
  const completionFailure: unknown = finish.mock.results[0]?.value;
  expect(failure).toBe(completionFailure);
});

test('partial input does not replace a ping timeout or add a native close wait', async () => {
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const finish = vi.spyOn(PacketDecoder.prototype, 'finish');
  ScriptedSocket.stallClose = true;
  const client = await createBrowserClient({ url: 'ws://localhost', clientId: 'timeout-partial', timeoutMs: 50 }).connect();
  ScriptedSocket.instance.receive([0xd0]);
  vi.useFakeTimers();
  let settled = false;
  const result = client.ping().catch((error: unknown) => {
    settled = true;
    return error;
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(settled).toBe(true);
  await expect(result).resolves.toMatchObject({ message: 'MQTT operation timed out' });
  expect(finish).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(50);
  expect(vi.getTimerCount()).toBe(0);
});

test('fragmented replies are completed only when the transport retires', async () => {
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const finish = vi.spyOn(PacketDecoder.prototype, 'finish');
  const client = await createBrowserClient({ url: 'ws://localhost', clientId: 'fragmented' }).connect();
  const ping = client.ping();
  ScriptedSocket.instance.receive([0xd0]);
  expect(finish).not.toHaveBeenCalled();
  ScriptedSocket.instance.receive([0]);
  await ping;
  expect(finish).not.toHaveBeenCalled();
  await client.disconnect();
  expect(finish).toHaveBeenCalledTimes(1);
});

test.each([
  {
    name: 'truncated MQTT input before CONNACK',
    bytes: [0x20, 3, 0],
    expected: { message: 'Truncated MQTT packet at end of input' },
  },
  {
    name: 'refusal before immediate close with partial trailing input',
    bytes: [0x20, 3, 0, 0x87, 0, 0x30],
    expected: { code: 0x87 },
  },
])(
  'a real native WebSocket reports $name',
  async ({
    bytes,
    expected,
  }: Readonly<{
    name: string;
    bytes: readonly number[];
    expected: Readonly<{ message?: string; code?: number }>;
  }>) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The scripted peer uses its native mutable WebSocket object.
    server.on('connection', (socket) => {
      socket.once('message', () => {
        socket.send(Uint8Array.from(bytes));
        socket.close();
      });
    });
    try {
      await expect(
        createBrowserClient({ url: 'ws://127.0.0.1:' + address.port, clientId: 'real-eof' }).connect(),
      ).rejects.toMatchObject(expected);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  },
);
