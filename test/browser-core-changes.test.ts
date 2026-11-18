// What the browser client changed when it moved onto the byte transport core and took on the Node inbound rules. Each
// case states the behavior on main before the move. AUTH (connack-agreement), QoS 1 without a handler (browser-client)
// and the first-byte header check (browser-eof) are pinned where those files already cover them.
import { afterEach, expect, test, vi } from 'vitest';
import { createBrowserClient } from '../src/browserClient.js';

const connack = [0x20, 3, 0, 0, 0];

/** A native WebSocket stand-in: opens at once, answers CONNECT with CONNACK and records what the client sends. */
class ScriptedSocket extends EventTarget {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instance: ScriptedSocket;
  static stallClose = false;
  protocol = 'mqtt';
  readyState = 1;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  sent: number[][] = [];
  constructor() {
    super();
    ScriptedSocket.instance = this;
    queueMicrotask(() => {
      this.dispatchEvent(new Event('open'));
    });
  }
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The stand-in receives the native send argument.
  send(bytes: Readonly<Uint8Array>) {
    this.sent.push([...bytes]);
    if (bytes[0] === 0x10)
      queueMicrotask(() => {
        this.receive(connack);
      });
  }
  receive(bytes: readonly number[]) {
    this.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from(bytes).buffer }));
  }
  close() {
    this.readyState = ScriptedSocket.CLOSING;
    if (!ScriptedSocket.stallClose)
      queueMicrotask(() => {
        this.readyState = ScriptedSocket.CLOSED;
        this.dispatchEvent(new Event('close'));
      });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  ScriptedSocket.stallClose = false;
});

const options = { url: 'ws://localhost', clientId: 'browser-changes' };

test('a close the peer does not finish resolves after the timeout instead of rejecting', async () => {
  // Main rejected the disconnect with 'MQTT WebSocket close timed out'.
  vi.stubGlobal('WebSocket', ScriptedSocket);
  ScriptedSocket.stallClose = true;
  const client = await createBrowserClient({ ...options, timeoutMs: 50 }).connect();
  vi.useFakeTimers();
  const closing = client.disconnect();
  await vi.advanceTimersByTimeAsync(50);
  await expect(closing).resolves.toBeUndefined();
});

test('a QoS 0 PUBLISH with DUP set is a protocol error answered with DISCONNECT 0x81', async () => {
  // Main failed the session with a generic decoder error and sent no DISCONNECT.
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const client = await createBrowserClient(options).connect();
  const pending = client.ping();
  ScriptedSocket.instance.receive([0x38, 4, 0, 1, 97, 0]);
  await expect(pending).rejects.toMatchObject({ code: 0x81 });
  await vi.waitFor(() => {
    expect(ScriptedSocket.instance.sent[ScriptedSocket.instance.sent.length - 1]).toEqual([0xe0, 1, 0x81]);
  });
});

test('a QoS 2 PUBLISH without a QoS 1 handler is dropped and the session goes on', async () => {
  // Main failed the session on the QoS 2 header.
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const onMessage = vi.fn<(message: unknown) => void>();
  const client = await createBrowserClient({ ...options, onMessage }).connect();
  ScriptedSocket.instance.receive([0x34, 6, 0, 1, 97, 0, 1, 0, 0x30, 5, 0, 1, 97, 0, 98]);
  await vi.waitFor(() => {
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
  await client.disconnect();
});

test.each([
  ['PUBREC', 0x50],
  ['PUBREL', 0x62],
  ['PUBCOMP', 0x70],
])('a %s is ignored as on Node, while QoS 2 is not supported', async (_name, header) => {
  // Main failed the session on these packets.
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const client = await createBrowserClient(options).connect();
  ScriptedSocket.instance.receive([header, 2, 0, 1]);
  const ping = client.ping();
  ScriptedSocket.instance.receive([0xd0, 0]);
  await expect(ping).resolves.toBeUndefined();
  await client.disconnect();
});

test('a packet over the limit fails the session with a RangeError', async () => {
  // Main failed it with a plain Error with the same message.
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const client = await createBrowserClient({ ...options, maxPacketBytes: 8 }).connect();
  const pending = client.ping();
  ScriptedSocket.instance.receive([0x30, 9, 0, 1, 97, 0, 1, 2, 3, 4, 5]);
  const failure: unknown = await pending.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RangeError);
  expect(failure).toMatchObject({ message: 'MQTT packet allocation limit exceeded' });
});

test('an invalid packet limit names the allowed range', async () => {
  // Main rejected it with 'MQTT integer out of range'.
  await expect(createBrowserClient({ ...options, maxPacketBytes: 1 }).connect()).rejects.toThrow(
    'MQTT packet capacity must be an integer from 2 to 268435460',
  );
});

test('an abort whose reason is not an Error names the WebSocket transport', async () => {
  // Main rejected with the raw reason before the open, and with 'MQTT WebSocket aborted' once open.
  const controller = new AbortController();
  controller.abort('stop');
  await expect(createBrowserClient({ ...options, signal: controller.signal }).connect()).rejects.toMatchObject({
    name: 'AbortError',
    message: 'WebSocket connection aborted',
  });
});

test('the timeout is validated before the packet limit', async () => {
  // Main validated the packet limit first and the timeout only when the native socket opened.
  await expect(createBrowserClient({ ...options, timeoutMs: 0, maxPacketBytes: 1 }).connect()).rejects.toThrow(
    'MQTT timeout must be a positive integer and fit in a timer',
  );
});
