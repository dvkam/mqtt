// What the browser client changed when it moved onto the byte transport core and took on the Node inbound rules. Each
// case states the behavior on main before the move. AUTH (connack-agreement), QoS 1 without a handler (browser-client)
// and the first-byte header check (browser-eof) are pinned where those files already cover them.
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createBrowserClient } from '../src/browserClient.js';

const connack = [0x20, 3, 0, 0, 0];

/** A native WebSocket stand-in: opens at once, answers CONNECT with CONNACK and records what the client sends. */
class ScriptedSocket extends EventTarget {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instance: ScriptedSocket;
  static stallClose = false;
  static created = 0;
  protocol = 'mqtt';
  readyState = 1;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  sent: number[][] = [];
  constructor() {
    super();
    ScriptedSocket.instance = this;
    ScriptedSocket.created++;
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
  ScriptedSocket.created = 0;
});

const options = { url: 'ws://localhost', clientId: 'browser-changes' };

test('a close the peer does not finish resolves after the timeout instead of rejecting', async () => {
  // Main rejected the disconnect with 'MQTT WebSocket close timed out'.
  vi.stubGlobal('WebSocket', ScriptedSocket);
  ScriptedSocket.stallClose = true;
  const controller = new AbortController();
  const client = await createBrowserClient({ ...options, timeoutMs: 50, signal: controller.signal }).connect();
  vi.useFakeTimers();
  const closing = client.disconnect();
  await vi.advanceTimersByTimeAsync(50);
  await expect(closing).resolves.toBeUndefined();
  // No close event came, but the close settled, so the caller's signal is released.
  expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  // The writer stopped waiting, so it no longer listens for the close event either.
  expect(getEventListeners(ScriptedSocket.instance, 'close')).toEqual([]);
});

test('a QoS 0 PUBLISH with DUP set is a protocol error answered with DISCONNECT 0x81', async () => {
  // Main failed the session with a generic decoder error and sent no DISCONNECT.
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const client = await createBrowserClient(options).connect();
  const pending = client.ping();
  ScriptedSocket.instance.receive([0x38, 4, 0, 1, 97, 0]);
  await expect(pending).rejects.toMatchObject({ reasonCode: 0x81 });
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
    code: 'ERR_MQTT_ABORTED',
  });
});

test('a pre-aborted signal wins over invalid options', async () => {
  // Main validated the options first and rejected with their RangeError.
  const reason = new Error('pre-aborted');
  await expect(
    createBrowserClient({ ...options, signal: AbortSignal.abort(reason), maxWebSocketMessageBytes: 0 }).connect(),
  ).rejects.toBe(reason);
});

test('a client-only packet from the broker fails on its first byte with 0x82 and DISCONNECT', async () => {
  // Main waited for the complete packet, so a malformed body failed as truncated input with no DISCONNECT.
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const client = await createBrowserClient(options).connect();
  const pending = client.ping();
  ScriptedSocket.instance.receive([0x10]);
  await expect(pending).rejects.toMatchObject({ reasonCode: 0x82 });
  await vi.waitFor(() => {
    expect(ScriptedSocket.instance.sent[ScriptedSocket.instance.sent.length - 1]).toEqual([0xe0, 1, 0x82]);
  });
});

test('a non-canonical Remaining Length names the Remaining Length', async () => {
  // Main reported 'Non-canonical MQTT variable integer'.
  vi.stubGlobal('WebSocket', ScriptedSocket);
  const client = await createBrowserClient(options).connect();
  const pending = client.ping();
  ScriptedSocket.instance.receive([0xd0, 0x80, 0x00]);
  await expect(pending).rejects.toThrow('Non-canonical MQTT Remaining Length');
});

test('a forced close does not wait for the native close and drops the close listener', async () => {
  // Main kept its close listener after an abort until a close event came.
  vi.stubGlobal('WebSocket', ScriptedSocket);
  ScriptedSocket.stallClose = true;
  const controller = new AbortController();
  const client = await createBrowserClient({ ...options, signal: controller.signal, timeoutMs: 60_000 }).connect();
  const removed = vi.spyOn(ScriptedSocket.instance, 'removeEventListener');
  const reason = new Error('stop');
  controller.abort(reason);
  await expect(client.ping()).rejects.toBe(reason);
  expect(removed).toHaveBeenCalledWith('close', expect.any(Function));
});

test('the timeout is validated before the packet limit', async () => {
  // Main validated the packet limit first and the timeout only when the native socket opened.
  await expect(createBrowserClient({ ...options, timeoutMs: 0, maxPacketBytes: 1 }).connect()).rejects.toThrow(
    'MQTT timeout must be a positive integer and fit in a timer',
  );
});

// Behavior of the browser opener that test/browser-transport.test.ts pinned on main and that the move kept.
describe('behavior the browser client keeps on the core', () => {
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'rejects the message limit %s before any socket opens',
    async (limit) => {
      vi.stubGlobal('WebSocket', ScriptedSocket);
      await expect(createBrowserClient({ ...options, maxWebSocketMessageBytes: limit }).connect()).rejects.toThrow(
        'WebSocket receive message limit must be an integer from 1 to 2147483647',
      );
      expect(ScriptedSocket.created).toBe(0);
    },
  );

  test('accepts the smallest message limit and enforces it on the five-byte CONNACK', async () => {
    vi.stubGlobal('WebSocket', ScriptedSocket);
    await expect(createBrowserClient({ ...options, maxWebSocketMessageBytes: 1 }).connect()).rejects.toThrow(
      'WebSocket receive message limit exceeded',
    );
    expect(ScriptedSocket.created).toBe(1);
  });

  test('accepts the largest message limit', async () => {
    vi.stubGlobal('WebSocket', ScriptedSocket);
    const client = await createBrowserClient({ ...options, maxWebSocketMessageBytes: 2_147_483_647 }).connect();
    expect(ScriptedSocket.created).toBe(1);
    await client.disconnect();
  });

  test('a text message fails the session', async () => {
    vi.stubGlobal('WebSocket', ScriptedSocket);
    const client = await createBrowserClient(options).connect();
    const pending = client.ping();
    ScriptedSocket.instance.dispatchEvent(new MessageEvent('message', { data: 'text' }));
    await expect(pending).rejects.toMatchObject({
      message: 'MQTT WebSocket requires binary messages',
      code: 'ERR_MQTT_TRANSPORT',
      fatal: true,
    });
  });

  test('a native error event fails the session and closes the socket', async () => {
    vi.stubGlobal('WebSocket', ScriptedSocket);
    const client = await createBrowserClient(options).connect();
    const pending = client.ping();
    ScriptedSocket.instance.dispatchEvent(new Event('error'));
    await expect(pending).rejects.toThrow('MQTT WebSocket failed');
    expect(ScriptedSocket.instance.readyState).not.toBe(ScriptedSocket.OPEN);
  });

  test('a write on a closing socket rejects instead of being dropped', async () => {
    vi.stubGlobal('WebSocket', ScriptedSocket);
    const client = await createBrowserClient(options).connect();
    const sent = ScriptedSocket.instance.sent.length;
    ScriptedSocket.instance.readyState = ScriptedSocket.CLOSING;
    await expect(client.publish('a', 'late')).rejects.toMatchObject({
      message: 'MQTT WebSocket closed',
      code: 'ERR_MQTT_TRANSPORT',
    });
    expect(ScriptedSocket.instance.sent).toHaveLength(sent);
  });

  test('an empty binary message is admitted', async () => {
    vi.stubGlobal('WebSocket', ScriptedSocket);
    const client = await createBrowserClient(options).connect();
    ScriptedSocket.instance.receive([]);
    const ping = client.ping();
    ScriptedSocket.instance.receive([0xd0, 0]);
    await expect(ping).resolves.toBeUndefined();
    await client.disconnect();
  });

  test.each([Number.NaN, -1, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'an invalid native bufferedAmount %s refuses the write',
    async (queued) => {
      vi.stubGlobal('WebSocket', ScriptedSocket);
      const client = await createBrowserClient(options).connect();
      ScriptedSocket.instance.bufferedAmount = queued;
      await expect(client.publish('a', 'x')).rejects.toThrow('WebSocket write budget exceeded');
    },
  );

  test('never sends a password, which the browser options do not have', async () => {
    vi.stubGlobal('WebSocket', ScriptedSocket);
    // An object that carries a password still type-checks, because only fresh literals get excess property checks.
    const carrier = { ...options, username: 'u', password: Uint8Array.of(1, 2) };
    const client = await createBrowserClient(carrier).connect();
    const flags = ScriptedSocket.instance.sent[0]?.[9] ?? 0;
    // CONNECT flags: 0x80 is the username, 0x40 the password.
    expect({ username: (flags & 0x80) !== 0, password: (flags & 0x40) !== 0 }).toEqual({ username: true, password: false });
    await client.disconnect();
  });

  test('a graceful close resolves when the close event comes, before the deadline', async () => {
    vi.stubGlobal('WebSocket', ScriptedSocket);
    const client = await createBrowserClient({ ...options, timeoutMs: 60_000 }).connect();
    const started = performance.now();
    await client.disconnect();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('a forced close stops message and error delivery before any close event', async () => {
    vi.stubGlobal('WebSocket', ScriptedSocket);
    ScriptedSocket.stallClose = true;
    const controller = new AbortController();
    const client = await createBrowserClient({ ...options, signal: controller.signal }).connect();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(client.ping()).rejects.toBe(reason);
    expect(getEventListeners(ScriptedSocket.instance, 'message')).toEqual([]);
    expect(getEventListeners(ScriptedSocket.instance, 'error')).toEqual([]);
  });

  test('an abort during a graceful disconnect settles it as soon as the socket closes', async () => {
    vi.stubGlobal('WebSocket', ScriptedSocket);
    ScriptedSocket.stallClose = true;
    const controller = new AbortController();
    const client = await createBrowserClient({ ...options, signal: controller.signal, timeoutMs: 60_000 }).connect();
    const socket = ScriptedSocket.instance;
    const started = performance.now();
    const closing = client.disconnect();
    await vi.waitFor(() => {
      expect(socket.readyState).toBe(ScriptedSocket.CLOSING);
    });
    controller.abort(new Error('stop'));
    socket.readyState = ScriptedSocket.CLOSED;
    socket.dispatchEvent(new Event('close'));
    await closing.catch(() => {});
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('a normal close leaves no close deadline timer behind', async () => {
    vi.stubGlobal('WebSocket', ScriptedSocket);
    const controller = new AbortController();
    const client = await createBrowserClient({ ...options, signal: controller.signal }).connect();
    vi.useFakeTimers();
    await client.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });
});
