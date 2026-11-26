import { afterEach, expect, test, vi } from 'vitest';
import { createTransportClient, type ByteInbound, type ByteTransport, type SessionEnd } from '../src/index.js';

const connack = Uint8Array.of(0x20, 6, 0, 0, 3, 0x13, 0, 1);
const pingresp = Uint8Array.of(0xd0, 0);

afterEach(() => {
  vi.useRealTimers();
});

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The peer passes the given byte view to the inbound endpoint.
function scriptedPeer(reply: Readonly<Uint8Array> = connack, connackDelayMs = 0, timeoutMs = 250) {
  let inbound: ByteInbound | undefined;
  const commands: number[] = [];
  const closed: boolean[] = [];
  const ends: SessionEnd[] = [];
  const caller = new AbortController();
  let finishWrite: (() => void) | undefined;
  let finishDisconnectWrite: (() => void) | undefined;
  let holdPing = false;
  let holdDisconnect = false;
  const transport: ByteTransport = {
    name: 'Keep Alive peer',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The peer retains the inbound endpoint to answer requests later.
    async open(input) {
      inbound = input;
      return Promise.resolve({
        bufferedBytes: 0,
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The writer receives the core's native bytes.
        async write(bytes) {
          const command = (bytes[0] ?? 0) >> 4;
          commands.push(command);
          if (command === 1) {
            if (connackDelayMs === 0) input.bytes(reply);
            else
              setTimeout(() => {
                input.bytes(reply);
              }, connackDelayMs);
          }
          if (command === 12 && holdPing)
            return new Promise((resolve) => {
              finishWrite = resolve;
            });
          if (command === 14 && holdDisconnect)
            return new Promise((resolve) => {
              finishDisconnectWrite = resolve;
            });
        },
        async close(force) {
          closed.push(force);
          finishWrite?.();
          finishDisconnectWrite?.();
          return Promise.resolve();
        },
      });
    },
  };
  const factory = createTransportClient(transport, {
    clientId: 'server-keep-alive',
    signal: caller.signal,
    timeoutMs,
    onSessionEnd: (outcome) => {
      ends.push(outcome);
    },
  });
  return {
    factory,
    caller,
    commands,
    closed,
    ends,
    answerPing() {
      inbound?.bytes(pingresp);
    },
    blockPingWrite() {
      holdPing = true;
    },
    blockDisconnectWrite() {
      holdDisconnect = true;
    },
    completeDisconnectWrite() {
      finishDisconnectWrite?.();
    },
  };
}

test('the broker override schedules an idle PINGREQ and successful writes defer it', async () => {
  vi.useFakeTimers();
  const peer = scriptedPeer();
  const client = await peer.factory.connect();

  await vi.advanceTimersByTimeAsync(600);
  await client.publish('ci/idle', 'hello');
  await vi.advanceTimersByTimeAsync(999);
  expect(peer.commands).toEqual([1, 3]);
  await vi.advanceTimersByTimeAsync(1);
  expect(peer.commands).toEqual([1, 3, 12]);

  peer.answerPing();
  await vi.advanceTimersByTimeAsync(1000);
  expect(peer.commands).toEqual([1, 3, 12, 12]);
  peer.answerPing();
  await client.disconnect();
  expect(vi.getTimerCount()).toBe(0);
});

test.each([Uint8Array.of(0x20, 3, 0, 0, 0), Uint8Array.of(0x20, 6, 0, 0, 3, 0x13, 0, 0)])(
  'CONNECT Keep Alive 0 sends no automatic pings if the server value is absent or zero (%j)',
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Vitest passes the fixed byte fixture by identity.
  async (reply) => {
    vi.useFakeTimers();
    const peer = scriptedPeer(reply);
    const client = await peer.factory.connect();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(peer.commands).toEqual([1]);
    await client.disconnect();
  },
);

test('a delayed CONNACK keeps the deadline anchored to the CONNECT write', async () => {
  vi.useFakeTimers();
  const peer = scriptedPeer(connack, 200);
  const connecting = peer.factory.connect();
  await vi.advanceTimersByTimeAsync(200);
  const client = await connecting;
  await vi.advanceTimersByTimeAsync(799);
  expect(peer.commands).toEqual([1]);
  await vi.advanceTimersByTimeAsync(1);
  expect(peer.commands).toEqual([1, 12]);
  peer.answerPing();
  await client.disconnect();
});

test('a manual ping owns its response while the idle timer expires', async () => {
  vi.useFakeTimers();
  const peer = scriptedPeer();
  const client = await peer.factory.connect();
  await vi.advanceTimersByTimeAsync(900);
  const manual = client.ping();
  await vi.advanceTimersByTimeAsync(150);
  expect(peer.commands).toEqual([1, 12]);
  await expect(client.ping()).rejects.toThrow('Another acknowledgment is pending');
  peer.answerPing();
  await manual;
  await vi.advanceTimersByTimeAsync(850);
  expect(peer.commands).toEqual([1, 12, 12]);
  peer.answerPing();
  await client.disconnect();
});

test('a manual ping can wait on an automatic exchange without another write', async () => {
  vi.useFakeTimers();
  const peer = scriptedPeer();
  const client = await peer.factory.connect();
  await vi.advanceTimersByTimeAsync(1000);
  const answered = vi.fn<() => void>();
  const manual = client.ping().then(answered);
  await vi.advanceTimersByTimeAsync(50);
  expect(peer.commands).toEqual([1, 12]);
  expect(answered).not.toHaveBeenCalled();
  peer.answerPing();
  await manual;
  expect(answered).toHaveBeenCalledOnce();
  await client.disconnect();
});

test.each(['no response', 'blocked write'] as const)('an automatic ping retires the session on %s', async (mode) => {
  vi.useFakeTimers();
  const peer = scriptedPeer();
  const client = await peer.factory.connect();
  if (mode === 'blocked write') peer.blockPingWrite();
  await vi.advanceTimersByTimeAsync(1000);
  expect(peer.commands).toEqual([1, 12]);
  const outcome = client.ping().catch((reason: unknown) => reason);
  if (mode === 'blocked write') peer.answerPing();
  await vi.advanceTimersByTimeAsync(250);
  const error = await outcome;
  expect(error).toMatchObject({ message: 'MQTT operation timed out' });
  expect(peer.ends).toEqual([{ kind: 'error', error }]);
  await expect(client.ping()).rejects.toBe(error);
  expect(peer.closed).toContain(true);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(5000);
  expect(peer.commands).toEqual([1, 12]);
});

test('abort stops the idle timer and keeps the original error', async () => {
  vi.useFakeTimers();
  const peer = scriptedPeer();
  const client = await peer.factory.connect();
  await vi.advanceTimersByTimeAsync(999);
  const reason = new Error('caller stopped');
  peer.caller.abort(reason);
  await expect(client.ping()).rejects.toBe(reason);
  await vi.advanceTimersByTimeAsync(2000);
  expect(peer.commands).toEqual([1]);
  expect(peer.ends).toEqual([{ kind: 'error', error: reason }]);
  expect(vi.getTimerCount()).toBe(0);
});

test('an automatic ping timeout cannot preempt a graceful disconnect already writing', async () => {
  vi.useFakeTimers();
  const peer = scriptedPeer();
  const client = await peer.factory.connect();
  await vi.advanceTimersByTimeAsync(1200);
  peer.blockDisconnectWrite();
  const closing = client.disconnect().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(peer.commands).toEqual([1, 12, 14]);
  peer.completeDisconnectWrite();
  await expect(closing).resolves.toBeUndefined();
  expect(peer.closed).toEqual([false]);
  expect(peer.ends).toEqual([{ kind: 'disconnect' }]);
  expect(vi.getTimerCount()).toBe(0);
});

test('a long operation timeout cannot leave a second idle interval without any control traffic', async () => {
  vi.useFakeTimers();
  const peer = scriptedPeer(connack, 0, 3000);
  const client = await peer.factory.connect();
  await vi.advanceTimersByTimeAsync(1000);
  const outcome = client.ping().catch((reason: unknown) => reason);
  await vi.advanceTimersByTimeAsync(999);
  expect(peer.ends).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(peer.ends).toHaveLength(1);
  await expect(outcome).resolves.toMatchObject({ message: 'MQTT Keep Alive deadline expired' });
  expect(peer.commands).toEqual([1, 12]);
  expect(vi.getTimerCount()).toBe(0);
});

test('a blocked manual ping cannot postpone the existing idle deadline', async () => {
  vi.useFakeTimers();
  const peer = scriptedPeer(connack, 0, 3000);
  const client = await peer.factory.connect();
  await vi.advanceTimersByTimeAsync(900);
  peer.blockPingWrite();
  const outcome = client.ping().catch((reason: unknown) => reason);
  await vi.advanceTimersByTimeAsync(100);
  expect(peer.ends).toHaveLength(1);
  await expect(outcome).resolves.toMatchObject({ message: 'MQTT Keep Alive deadline expired' });
  expect(peer.commands).toEqual([1, 12]);
  expect(vi.getTimerCount()).toBe(0);
});

test('successful writes let a manual ping keep its configured response timeout', async () => {
  vi.useFakeTimers();
  const peer = scriptedPeer(connack, 0, 3000);
  const client = await peer.factory.connect();
  const manual = client.ping().catch((reason: unknown) => reason);
  await vi.advanceTimersByTimeAsync(800);
  await client.publish('ci/idle', 'still writing');
  await vi.advanceTimersByTimeAsync(400);
  expect(peer.ends).toEqual([]);
  peer.answerPing();
  await expect(manual).resolves.toBeUndefined();
  await client.disconnect();
  expect(peer.commands).toEqual([1, 12, 3, 14]);
});
