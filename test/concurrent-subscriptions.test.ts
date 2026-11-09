import { setImmediate } from 'node:timers/promises';
import type { Packet } from 'mqtt-packet';
import { expect, test, vi } from 'vitest';
import { connectPortable, type PacketTransport } from '../src/portable.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

async function peer(options = {}) {
  let receive!: Parameters<PacketTransport['listen']>[0];
  let retire!: Parameters<PacketTransport['listen']>[1];
  const packets: Packet[] = [];
  const transport: PacketTransport = {
    // oxlint-disable-next-line typescript/require-await, typescript/prefer-readonly-parameter-types -- The scripted transport delivers mutable packets synchronously before its send promise settles.
    async send(packet) {
      packets.push(packet);
      if (packet.cmd === 'connect') receive({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
    },
    listen(onPacket, onClose) {
      receive = onPacket;
      retire = onClose;
      return () => {};
    },
    async close() {},
  };
  const client = await connectPortable(transport, { clientId: 'concurrent', ...options });
  return { client, transport, packets, receive, retire };
}

test('correlates concurrent subscriptions by identifier and kind while ping stays independent', async () => {
  const broker = await peer();
  const completed: string[] = [];
  const first = broker.client.subscribe('first').then(() => completed.push('first'));
  const second = broker.client.subscribe('second').then(() => completed.push('second'));
  const ping = broker.client.ping().then(() => completed.push('ping'));
  const outcomes = Promise.allSettled([first, second, ping]);
  try {
    expect(broker.packets.map(({ cmd }: Readonly<{ cmd: string }>) => cmd)).toEqual([
      'connect',
      'subscribe',
      'subscribe',
      'pingreq',
    ]);
    expect(broker.packets[1]).toMatchObject({ messageId: 1 });
    expect(broker.packets[2]).toMatchObject({ messageId: 2 });
    broker.receive({ cmd: 'puback', messageId: 1 });
    broker.receive({ cmd: 'suback', messageId: 99, granted: [0] });
    await setImmediate();
    expect(completed).toEqual([]);
    broker.receive({ cmd: 'suback', messageId: 2, granted: [0] });
    await second;
    expect(completed).toEqual(['second']);
    broker.receive({ cmd: 'suback', messageId: 2, granted: [128] });
    broker.receive({ cmd: 'pingresp' });
    await ping;
    broker.receive({ cmd: 'suback', messageId: 1, granted: [0] });
    await first;
    expect(completed).toEqual(['second', 'ping', 'first']);
  } finally {
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});

test('retains count and byte capacity after SUBACK until actual send settlement', async () => {
  const broker = await peer({ maxPendingSubscriptions: 1, maxPendingSubscriptionBytes: 9 });
  const sent = deferred();
  const original = broker.transport.send.bind(broker.transport);
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The held-send fixture preserves mutable protocol packets.
  broker.transport.send = async (packet) => (packet.cmd === 'subscribe' ? sent.promise : original(packet));
  const first = broker.client.subscribe('a');
  const outcome = Promise.allSettled([first]);
  try {
    broker.receive({ cmd: 'suback', messageId: 1, granted: [0] });
    await setImmediate();
    await expect(broker.client.subscribe('b')).rejects.toThrow('MQTT subscription capacity exceeded');
    sent.resolve();
    await first;
    broker.transport.send = original;
    const next = broker.client.subscribe('b');
    broker.receive({ cmd: 'suback', messageId: 2, granted: [0] });
    await next;
  } finally {
    sent.resolve();
    broker.retire(new Error('fixture ended'));
    await outcome;
  }
});

test('bounds retained subscription bytes before sending or consuming an identifier', async () => {
  const broker = await peer({ maxPendingSubscriptions: 4, maxPendingSubscriptionBytes: 18 });
  const first = broker.client.subscribe('a');
  const second = broker.client.subscribe('b');
  const outcomes = Promise.allSettled([first, second]);
  try {
    await expect(broker.client.subscribe('c')).rejects.toBeInstanceOf(RangeError);
    expect(broker.packets).toHaveLength(3);
    broker.receive({ cmd: 'suback', messageId: 2, granted: [0] });
    await second;
    const next = broker.client.subscribe('c');
    expect(broker.packets[3]).toMatchObject({ messageId: 3 });
    broker.receive({ cmd: 'suback', messageId: 3, granted: [0] });
    await next;
    broker.receive({ cmd: 'suback', messageId: 1, granted: [0] });
    await first;
  } finally {
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});

test('an uncertain subscription send failure retires other exchanges and fences new work', async () => {
  const broker = await peer();
  const sent = deferred();
  const failure = new Error('could not confirm subscription write');
  broker.transport.send = async () => sent.promise;
  const close = vi.spyOn(broker.transport, 'close');
  const first = broker.client.subscribe('first').catch((reason: unknown) => reason);
  const second = broker.client.subscribe('second').catch((reason: unknown) => reason);
  sent.reject(failure);
  expect(await first).toBe(failure);
  expect(await second).toBe(failure);
  await expect(broker.client.subscribe('late')).rejects.toBe(failure);
  expect(close).toHaveBeenCalledExactlyOnceWith(true);
});

test('a completed native send retains capacity until its matching SUBACK', async () => {
  const broker = await peer({ maxPendingSubscriptions: 1 });
  const first = broker.client.subscribe('a');
  const outcome = Promise.allSettled([first]);
  try {
    await setImmediate();
    await expect(broker.client.subscribe('b')).rejects.toThrow('MQTT subscription capacity exceeded');
    broker.receive({ cmd: 'suback', messageId: 1, granted: [0] });
    await first;
    const next = broker.client.subscribe('b');
    broker.receive({ cmd: 'suback', messageId: 2, granted: [0] });
    await next;
  } finally {
    broker.retire(new Error('fixture ended'));
    await outcome;
  }
});

test('a legal SUBACK refusal waits for send settlement and ignores a later malformed duplicate', async () => {
  const broker = await peer({ maxPendingSubscriptions: 1 });
  const sent = deferred();
  const original = broker.transport.send.bind(broker.transport);
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The held-send fixture preserves mutable protocol packets.
  broker.transport.send = async (packet) => (packet.cmd === 'subscribe' ? sent.promise : original(packet));
  let settled = false;
  const first = broker.client.subscribe('a').catch((reason: unknown) => {
    settled = true;
    return reason;
  });
  try {
    broker.receive({ cmd: 'suback', messageId: 1, granted: [128] });
    broker.receive({ cmd: 'suback', messageId: 1, granted: [0, 0] });
    await setImmediate();
    expect(settled).toBe(false);
    await expect(broker.client.subscribe('b')).rejects.toThrow('MQTT subscription capacity exceeded');
    sent.resolve();
    expect(await first).toMatchObject({ message: 'MQTT acknowledgment refused', code: 128 });
    broker.transport.send = original;
    const next = broker.client.subscribe('b');
    broker.receive({ cmd: 'suback', messageId: 2, granted: [0] });
    await next;
  } finally {
    sent.resolve();
    broker.retire(new Error('fixture ended'));
    await first;
  }
});

test('subscription timeout retires all ownership before a late send or ACK can admit work', async () => {
  vi.useFakeTimers();
  const broker = await peer({ timeoutMs: 100, maxPendingSubscriptions: 2 });
  const sent = deferred();
  broker.transport.send = async () => sent.promise;
  const first = broker.client.subscribe('a').catch((reason: unknown) => reason);
  const second = broker.client.subscribe('b').catch((reason: unknown) => reason);
  try {
    vi.advanceTimersByTime(100);
    const late = broker.client.subscribe('c').catch((reason: unknown) => reason);
    sent.resolve();
    broker.receive({ cmd: 'suback', messageId: 1, granted: [0] });
    const failure = await first;
    expect(failure).toMatchObject({ message: 'MQTT operation timed out' });
    expect(await second).toBe(failure);
    expect(await late).toBe(failure);
  } finally {
    sent.resolve();
    broker.retire(new Error('fixture ended'));
    await Promise.all([first, second]);
    vi.useRealTimers();
  }
});

test('count rejection creates no send or operation timer', async () => {
  const broker = await peer({ maxPendingSubscriptions: 1 });
  const first = broker.client.subscribe('a');
  const outcome = Promise.allSettled([first]);
  const timer = vi.spyOn(globalThis, 'setTimeout');
  const send = vi.spyOn(broker.transport, 'send');
  try {
    await expect(broker.client.subscribe('b')).rejects.toThrow('MQTT subscription capacity exceeded');
    expect(send).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
  } finally {
    timer.mockRestore();
    send.mockRestore();
    broker.retire(new Error('fixture ended'));
    await outcome;
  }
});

test('graceful disconnect retires concurrent subscriptions and ping exactly once', async () => {
  const broker = await peer();
  const close = vi.spyOn(broker.transport, 'close');
  const first = broker.client.subscribe('a').catch((reason: unknown) => reason);
  const second = broker.client.subscribe('b').catch((reason: unknown) => reason);
  const ping = broker.client.ping().catch((reason: unknown) => reason);
  const closing = broker.client.disconnect();
  expect(broker.client.disconnect()).toBe(closing);
  await closing;
  const failure = await first;
  expect(failure).toMatchObject({ message: 'Client disconnected' });
  expect(await second).toBe(failure);
  expect(await ping).toBe(failure);
  broker.receive({ cmd: 'suback', messageId: 1, granted: [0] });
  broker.receive({ cmd: 'suback', messageId: 2, granted: [0] });
  await expect(broker.client.subscribe('late')).rejects.toThrow('Client is closing');
  expect(close).toHaveBeenCalledExactlyOnceWith();
});

test.each([
  { kind: 'suback', granted: [1], code: 0x82 },
  { kind: 'suback', granted: [17], code: 0x82 },
  { kind: 'suback', granted: [NaN], code: 0x81 },
  { kind: 'suback', granted: [17, 0], code: 0x82 },
  { kind: 'suback', granted: [0, 17], code: 0x82 },
  { kind: 'suback', granted: [], code: 0x81 },
  { kind: 'suback', granted: [0, 0], code: 0x82 },
  { kind: 'unsuback', granted: [0, 17], code: 0x82 },
  { kind: 'unsuback', granted: [1], code: 0x82 },
] as const)('retires on a first malformed $kind with $granted while send remains held', async ({ kind, granted, code }) => {
  const broker = await peer();
  const write = deferred();
  const original = broker.transport.send.bind(broker.transport);
  const close = vi.spyOn(broker.transport, 'close');
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture retains the original mutable subscription packet.
  broker.transport.send = async (packet) => {
    await original(packet);
    if (packet.cmd === 'subscribe' || packet.cmd === 'unsubscribe') await write.promise;
  };
  const changed = kind === 'suback' ? broker.client.subscribe('a') : broker.client.unsubscribe('a');
  const ping = broker.client.ping();
  const outcomes = Promise.allSettled([changed, ping]);
  try {
    broker.receive({ cmd: kind, messageId: 1, granted: [...granted] });
    const subsequent = broker.client.publish('b', 'must not send').catch((reason: unknown) => reason);
    await setImmediate();
    expect(broker.packets.map(({ cmd }: Readonly<{ cmd: string }>) => cmd)).toEqual([
      'connect',
      kind === 'suback' ? 'subscribe' : 'unsubscribe',
      'pingreq',
      'disconnect',
    ]);
    expect(broker.packets[3]).toEqual({ cmd: 'disconnect', reasonCode: code });
    const failure = await subsequent;
    expect(failure).toMatchObject({ code });
    for (const outcome of await outcomes) {
      if (outcome.status === 'fulfilled') throw new Error('Expected the pending request to reject');
      expect(outcome.reason).toBe(failure);
    }
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    write.resolve();
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});

test('retires a malformed subscription reply during closing without sending another DISCONNECT', async () => {
  const broker = await peer();
  const write = deferred();
  const original = broker.transport.send.bind(broker.transport);
  const close = vi.spyOn(broker.transport, 'close');
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Hold the original DISCONNECT write after recording it.
  broker.transport.send = async (packet) => {
    await original(packet);
    if (packet.cmd === 'disconnect') await write.promise;
  };
  const subscription = broker.client.subscribe('a');
  const disconnect = broker.client.disconnect();
  const outcomes = Promise.allSettled([subscription, disconnect]);
  try {
    await setImmediate();
    broker.receive({ cmd: 'suback', messageId: 1, granted: [0, 0] });
    await setImmediate();
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
    expect(broker.packets.filter(({ cmd }: Readonly<{ cmd: string }>) => cmd === 'disconnect')).toEqual([{ cmd: 'disconnect' }]);
    const [first, second] = await outcomes;
    if (first.status !== 'rejected' || second.status !== 'rejected') throw new Error('Expected both operations to reject');
    expect(first.reason).toMatchObject({ code: 0x82 });
    expect(second.reason).toBe(first.reason);
  } finally {
    write.resolve();
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});
