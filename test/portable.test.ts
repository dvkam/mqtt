import type { Packet } from 'mqtt-packet';
import { expect, test, vi } from 'vitest';
import { connectPortable, type PacketTransport } from '../src/portable.js';

test.each(['', '+', 'a/#', 'a+b', 'a\u0000b', '\uD800', '\uDC00', 'a'.repeat(65_536), 'é'.repeat(32_768)])(
  'rejects an invalid publication before transport send and keeps the session active',
  async (topic) => {
    const broker = peer();
    const client = await connectPortable(broker.transport, { clientId: 'invalid-topic' });
    await expect(client.publish(topic, 'payload')).rejects.toThrow('Invalid MQTT topic name');
    expect(broker.packets).toEqual([expect.objectContaining({ cmd: 'connect' })]);
    await client.publish('valid/topic', 'next');
    expect(broker.packets[1]).toMatchObject({ cmd: 'publish', topic: 'valid/topic', payload: 'next' });
    await client.disconnect();
  },
);

test.each(['/', 'a//b', '$SYS/status', '😀', '\uFEFFtopic', 'a'.repeat(65_535), `${'é'.repeat(32_767)}a`])(
  'preserves a valid publication topic without normalization',
  async (topic) => {
    const broker = peer();
    const client = await connectPortable(broker.transport, { clientId: 'valid-topic' });
    await client.publish(topic, 'payload');
    expect(broker.packets[1]).toMatchObject({ cmd: 'publish', topic });
    await client.disconnect();
  },
);

test('invalid publication input cannot replace an established terminal failure', async () => {
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'closed-invalid-topic' });
  const reason = new Error('connection retired');
  broker.close(reason);
  await expect(client.publish('#', 'payload')).rejects.toBe(reason);
  expect(broker.packets).toEqual([expect.objectContaining({ cmd: 'connect' })]);
});

test.each(['', 'a\u0000b', '\uD800', 'a'.repeat(65_536), 'é'.repeat(32_768), 'sport/#/score'])(
  'rejects an invalid subscription before sending and keeps the session active',
  async (filter) => {
    const broker = peer();
    const client = await connectPortable(broker.transport, { clientId: 'invalid-filter' });
    await expect(client.subscribe(filter)).rejects.toThrow('Invalid MQTT topic filter');
    expect(broker.packets).toEqual([expect.objectContaining({ cmd: 'connect' })]);
    await client.subscribe('valid/+');
    expect(broker.packets[1]).toMatchObject({ cmd: 'subscribe', messageId: 1 });
    const ping = client.ping();
    broker.receive({ cmd: 'pingresp' });
    await ping;
    await client.disconnect();
    expect(broker.packets[broker.packets.length - 1]).toMatchObject({ cmd: 'disconnect' });
  },
);

test('invalid subscription input cannot replace an established terminal failure', async () => {
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'closed-invalid-filter' });
  const reason = new Error('connection retired');
  broker.close(reason);
  await expect(client.subscribe('a\u0000b')).rejects.toBe(reason);
  expect(broker.packets).toEqual([expect.objectContaining({ cmd: 'connect' })]);
});

test('a matching refused CONNACK owns the result before a synchronous trailing close', async () => {
  const broker = peer();
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The transport retains its mutable packet callback contract.
  broker.transport.send = async (packet) => {
    if (packet.cmd === 'connect') {
      broker.receive({ cmd: 'connack', sessionPresent: false, reasonCode: 135 });
      broker.close(new Error('trailing input closed'));
    }
    await Promise.resolve();
  };
  await expect(connectPortable(broker.transport, { clientId: 'refused-before-close' })).rejects.toMatchObject({
    message: 'MQTT acknowledgment refused',
    code: 135,
  });
});

test('a later captured transport close cannot replace the first active failure', async () => {
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'first-close-wins' });
  const reason = new Error('first transport failure');
  broker.close(reason);
  broker.close(new Error('later transport failure'));
  await expect(client.publish('a', 'late')).rejects.toBe(reason);
});

test.each([undefined, 0, 0x8e])('broker DISCONNECT %s owns the terminal result before native close', async (reasonCode) => {
  const broker = peer();
  const close = vi.spyOn(broker.transport, 'close');
  const onMessage = vi.fn<(packet: unknown) => void>();
  const client = await connectPortable(broker.transport, { clientId: 'broker-disconnect', onMessage });
  const pending = client.ping().catch((reason: unknown) => reason);
  broker.receive({ cmd: 'disconnect', reasonCode });
  const later = client.publish('a', 'late').catch((reason: unknown) => reason);
  expect(broker.packets).toHaveLength(2);
  broker.receive({ cmd: 'publish', topic: 'a', payload: 'suffix', qos: 0, dup: false, retain: false });
  broker.receive({ cmd: 'disconnect', reasonCode: 0x80 });
  broker.close(new Error('trailing native close'));
  const reason = await pending;
  expect(reason).toMatchObject({ message: 'MQTT broker disconnected', code: reasonCode ?? 0 });
  await expect(later).resolves.toBe(reason);
  await expect(client.subscribe('a')).rejects.toBe(reason);
  expect(onMessage).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledExactlyOnceWith(true);
});

test('broker DISCONNECT retires an idle session without a pending exchange', async () => {
  const broker = peer();
  const close = vi.spyOn(broker.transport, 'close');
  const client = await connectPortable(broker.transport, { clientId: 'idle-disconnect' });
  broker.receive({ cmd: 'disconnect' });
  await expect(client.publish('a', 'late')).rejects.toMatchObject({ message: 'MQTT broker disconnected', code: 0 });
  expect(broker.packets).toHaveLength(1);
  expect(close).toHaveBeenCalledExactlyOnceWith(true);
});

test('DISCONNECT after CONNACK but before handoff rejects the opening attempt', async () => {
  const broker = peer();
  // oxlint-disable-next-line typescript/require-await -- The fixture delivers the two broker packets synchronously before send completion.
  broker.transport.send = async () => {
    broker.receive({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
    broker.receive({ cmd: 'disconnect', reasonCode: 0x8e });
  };
  await expect(connectPortable(broker.transport, { clientId: 'opening-disconnect' })).rejects.toMatchObject({
    message: 'MQTT broker disconnected',
    code: 0x8e,
  });
});

function peer() {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  let receive: (packet: Packet) => void;
  let closed: (error: Readonly<Error>) => void;
  const packets: Packet[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const sent: PacketTransport['send'] = async (packet) => {
    packets.push(packet);
    if (packet.cmd === 'connect') receive({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
    if (packet.cmd === 'subscribe') receive({ cmd: 'suback', messageId: packet.messageId, granted: [0] });
    if (packet.cmd === 'publish') receive(packet);
  };
  const transport: PacketTransport = {
    send: sent,
    listen(onPacket, onClose) {
      receive = onPacket;
      closed = onClose;
      return () => {};
    },
    async close() {},
  };
  return {
    transport,
    packets,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    receive: (packet: Packet) => {
      receive(packet);
    },
    close: (error: Readonly<Error>) => {
      closed(error);
    },
  };
}

test('completes the MQTT 5 QoS 0 tracer through an injected packet transport', async () => {
  const broker = peer();
  const { transport, packets } = broker;
  const messages: unknown[] = [];
  const client = await connectPortable(transport, {
    clientId: 'tracer',
    onMessage: (packet: Readonly<{ topic: string }>) => {
      messages.push(packet);
    },
  });
  await client.subscribe('tracer/echo');
  await client.publish.call(undefined, 'tracer/echo', 'hello');
  const pendingPing = client.ping.call(undefined);
  broker.receive({ cmd: 'pingresp' });
  await pendingPing;
  const closing = client.disconnect.call(undefined);
  expect(client.disconnect.call(undefined)).toBe(closing);
  await closing;

  expect(packets.map(({ cmd }: Readonly<{ cmd: string }>) => cmd)).toEqual([
    'connect',
    'subscribe',
    'publish',
    'pingreq',
    'disconnect',
  ]);
  expect(messages).toEqual([{ cmd: 'publish', qos: 0, topic: 'tracer/echo', payload: 'hello', dup: false, retain: false }]);
});

test('settles a blocked publish with the transport failure before drain', async () => {
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'tracer' });
  broker.transport.send = async () => new Promise(() => {});
  const published = client.publish('tracer/echo', 'hello');
  broker.close(new Error('closed before drain'));
  await expect(published).rejects.toThrow('closed before drain');
  await expect(client.publish('tracer/echo', 'again')).rejects.toThrow('closed before drain');
});

test.each([0, 1, 2, 3, 4, 5, 6, 7])('fences a retry %i microtasks after the ping timer fires', async (hops) => {
  vi.useFakeTimers();
  try {
    const { transport, packets } = peer();
    const client = await connectPortable(transport, { clientId: 'tracer', timeoutMs: 100 });
    const first = client.ping().catch((error: unknown) => error);
    vi.advanceTimersByTime(100);
    const retry = new Promise<void>((resolve, reject) => {
      let remaining = hops;
      const schedule = () => {
        if (remaining-- > 0) queueMicrotask(schedule);
        else client.ping().then(resolve, reject);
      };
      schedule();
    }).catch((error: unknown) => error);
    await Promise.all([first, retry]);
    expect(packets.map(({ cmd }: Readonly<{ cmd: string }>) => cmd)).toEqual(['connect', 'pingreq']);
  } finally {
    vi.useRealTimers();
  }
});

test('retires a ping whose transport write rejects after admitting bytes', async () => {
  const { transport, packets } = peer();
  const client = await connectPortable(transport, { clientId: 'tracer' });
  const writeError = new Error('could not confirm the write');
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  transport.send = async (packet) => {
    packets.push(packet);
    throw writeError;
  };
  await expect(client.ping()).rejects.toBe(writeError);
  await expect(client.ping()).rejects.toBe(writeError);
  expect(packets.map(({ cmd }: Readonly<{ cmd: string }>) => cmd)).toEqual(['connect', 'pingreq']);
});

test('ignores a queued application frame delivered after transport failure', async () => {
  const broker = peer();
  const messages: unknown[] = [];
  const client = await connectPortable(broker.transport, {
    clientId: 'late-frame',
    onMessage: (packet: unknown) => {
      messages.push(packet);
    },
  });
  const reason = new Error('transport closed');
  broker.close(reason);
  broker.receive({ cmd: 'publish', topic: 'late', payload: 'late', qos: 0, dup: false, retain: false });
  await expect(client.publish('late', 'reply')).rejects.toBe(reason);
  expect(messages).toEqual([]);
});

test('opt-in diagnostics include only connection state and packet commands', async () => {
  const broker = peer();
  const events: unknown[] = [];
  const client = await connectPortable(broker.transport, {
    clientId: 'private-client',
    username: 'private-user',
    password: Buffer.from('private-password'),
    onDiagnostic(event: unknown) {
      events.push(event);
    },
  });
  broker.receive({
    cmd: 'auth',
    reasonCode: 0x18,
    properties: { authenticationMethod: 'private-method', authenticationData: Buffer.from('private-auth') },
  });
  Reflect.apply(broker.receive, undefined, [{ cmd: 'private-unrecognized-command' }]);
  await client.publish('private/topic', 'private-payload');
  broker.close(new Error('private-failure'));
  expect(events).toEqual([
    { kind: 'packet', direction: 'inbound', command: 'connack' },
    { kind: 'packet', direction: 'outbound', command: 'connect' },
    { kind: 'connection', state: 'active' },
    { kind: 'packet', direction: 'inbound', command: 'auth' },
    { kind: 'packet', direction: 'inbound', command: 'publish' },
    { kind: 'packet', direction: 'outbound', command: 'publish' },
    { kind: 'connection', state: 'retired' },
  ]);
});

test.each(['throw', 'reject'])('a diagnostic observer can %s without replacing session outcomes', async (mode) => {
  const broker = peer();
  const observerFailure = new Error('observer failure');
  let calls = 0;
  const client = await connectPortable(broker.transport, {
    clientId: 'observer',
    onDiagnostic:
      mode === 'throw'
        ? () => {
            calls++;
            throw observerFailure;
          }
        : async () => {
            calls++;
            await Promise.reject(observerFailure);
          },
  });
  const pending = client.ping();
  broker.receive({ cmd: 'pingresp' });
  await pending;
  const terminal = new Error('transport failure');
  broker.close(terminal);
  await expect(client.ping()).rejects.toBe(terminal);
  expect(calls).toBeGreaterThan(0);
});

test('retirement during the active diagnostic rejects the connection with its first reason', async () => {
  const broker = peer();
  const failure = new Error('retired during diagnostics');
  const states: string[] = [];
  await expect(
    connectPortable(broker.transport, {
      clientId: 'diagnostic-retirement',
      onDiagnostic(event) {
        if (event.kind !== 'connection') return;
        states.push(event.state);
        if (event.state === 'active') broker.close(failure);
      },
    }),
  ).rejects.toBe(failure);
  expect(states).toEqual(['active', 'retired']);
});

test('a synchronous send failure reaches the session before diagnostics', async () => {
  const broker = peer();
  const original = new Error('write failed');
  const replacement = new Error('observer retired transport');
  const client = await connectPortable(broker.transport, {
    clientId: 'diagnostic-sync-send',
    onDiagnostic(event) {
      if (event.kind === 'packet' && event.direction === 'outbound' && event.command === 'pingreq') broker.close(replacement);
    },
  });
  broker.transport.send = () => {
    throw original;
  };
  await expect(client.ping()).rejects.toBe(original);
  await expect(client.ping()).rejects.toBe(original);
});

test('a rejected observer promise with an overridden catch cannot escape', async () => {
  const broker = peer();
  const overriddenCatch = vi.fn<() => never>(() => {
    throw new Error('overridden catch');
  });
  const onDiagnostic = vi.fn<(event: unknown) => void | Promise<void>>();
  onDiagnostic.mockReturnValue(Object.assign(Promise.reject(new Error('observer rejection')), { catch: overriddenCatch }));
  const client = await connectPortable(broker.transport, { clientId: 'rejecting-observer', onDiagnostic });
  await client.disconnect();
  expect(onDiagnostic).toHaveBeenCalled();
  expect(overriddenCatch).not.toHaveBeenCalled();
});

test.each([false, true])('keeps the opening QoS 1 retirement with diagnostics enabled = %s', async (enabled) => {
  const broker = peer();
  const failure = new Error('opening handler retired transport');
  const connecting = connectPortable(broker.transport, {
    clientId: 'opening-handler',
    onDiagnostic: enabled ? () => {} : undefined,
    onQosOneMessage() {
      broker.close(failure);
    },
  });
  broker.receive({ cmd: 'publish', topic: 'early', payload: 'message', qos: 1, messageId: 1, dup: false, retain: false });
  await expect(connecting).rejects.toBe(failure);
});
