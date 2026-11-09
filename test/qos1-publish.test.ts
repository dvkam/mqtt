import { setImmediate } from 'node:timers/promises';
import { generate, type IConnackPacket, type Packet } from 'mqtt-packet';
import { expect, test, vi } from 'vitest';
import { connectPortable, type PacketTransport, type PortableOptions } from '../src/portable.js';
import { PublicationAdmission } from '../src/publicationAdmission.js';
import { PacketIdentifiers } from '../src/packetIdentifiers.js';

const qosOne = { qos: 1 } as const;

function gate() {
  let release!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, refuse) => {
    release = resolve;
    reject = refuse;
  });
  return { promise, release, reject };
}

async function peer(
  properties?: Readonly<Pick<NonNullable<IConnackPacket['properties']>, 'receiveMaximum' | 'maximumQoS'>>,
  limits?: Readonly<Pick<PortableOptions, 'maxPendingPublishes' | 'maxPendingPublishBytes' | 'timeoutMs'>>,
  afterConnack?: () => void,
) {
  let receive!: Parameters<PacketTransport['listen']>[0];
  let retire!: Parameters<PacketTransport['listen']>[1];
  const packets: Packet[] = [];
  const transport: PacketTransport = {
    // oxlint-disable-next-line typescript/require-await, typescript/prefer-readonly-parameter-types -- The fixture records mutable transport packets and delivers replies synchronously.
    async send(packet) {
      packets.push(packet);
      if (packet.cmd === 'connect') {
        receive({ cmd: 'connack', sessionPresent: false, reasonCode: 0, properties });
        afterConnack?.();
      }
      if (packet.cmd === 'pingreq') receive({ cmd: 'pingresp' });
    },
    listen(onPacket, onClose) {
      receive = onPacket;
      retire = onClose;
      return () => {};
    },
    async close() {},
  };
  const client = await connectPortable(transport, { clientId: 'qos1-trace', ...limits });
  const published = () => packets.filter((packet: Readonly<{ cmd: string }>) => packet.cmd === 'publish');
  return { client, transport, packets, published, receive, retire };
}

test('holds quota one through send and matching PUBACK while subscription and ping proceed', async () => {
  const broker = await peer({ receiveMaximum: 1 });
  const write = gate();
  const original = broker.transport.send.bind(broker.transport);
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The held send forwards the fixture's mutable transport packet.
  broker.transport.send = async (packet) => {
    await original(packet);
    if (packet.cmd === 'publish' && packet.topic === 'a') await write.promise;
  };
  const first = broker.client.publish('a', 'one', qosOne);
  const second = broker.client.publish('b', 'two', qosOne);
  const subscription = broker.client.subscribe('updates');
  const outcomes = Promise.allSettled([first, second, subscription]);
  try {
    expect(broker.published()).toEqual([expect.objectContaining({ cmd: 'publish', qos: 1, messageId: 1, topic: 'a' })]);
    expect(broker.packets).toContainEqual(expect.objectContaining({ cmd: 'subscribe', messageId: 2 }));
    broker.receive({ cmd: 'suback', messageId: 1, granted: [0] });
    broker.receive({ cmd: 'puback', messageId: 2, reasonCode: 0 });
    await broker.client.ping();
    expect(broker.published()).toHaveLength(1);
    broker.receive({ cmd: 'suback', messageId: 2, granted: [0] });
    await subscription;
    broker.receive({ cmd: 'puback', messageId: 1, reasonCode: 0 });
    await setImmediate();
    expect(broker.published()).toHaveLength(1);
    write.release();
    await first;
    expect(broker.published()[1]).toMatchObject({ qos: 1, messageId: 3, topic: 'b' });
    broker.receive({ cmd: 'puback', messageId: 3, reasonCode: 0x10 });
    await second;
  } finally {
    write.release();
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});

test('uses a broker quota of two and handles a negative PUBACK without closing the session', async () => {
  const broker = await peer({ receiveMaximum: 2 });
  const first = broker.client.publish('a', 'one', qosOne);
  const second = broker.client.publish('b', 'two', qosOne);
  const third = broker.client.publish('c', 'three', qosOne);
  const outcomes = Promise.allSettled([first, second, third]);
  try {
    expect(broker.published()).toHaveLength(2);
    broker.receive({ cmd: 'puback', messageId: 2, reasonCode: 0x97 });
    await expect(second).rejects.toMatchObject({ code: 0x97 });
    expect(broker.published()[2]).toMatchObject({ qos: 1, messageId: 3, topic: 'c' });
    broker.receive({ cmd: 'puback', messageId: 1 });
    broker.receive({ cmd: 'puback', messageId: 3, reasonCode: 0x10 });
    await Promise.all([first, third]);
    await broker.client.ping();
  } finally {
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});

test('queued abort returns bytes and consumes neither a timer nor an identifier', async () => {
  const broker = await peer({ receiveMaximum: 1 }, { maxPendingPublishes: 4, maxPendingPublishBytes: 18 });
  const controller = new AbortController();
  const reason = Symbol('cancel queued');
  const first = broker.client.publish('a', 'x', qosOne);
  const timer = vi.spyOn(globalThis, 'setTimeout');
  const queued = broker.client.publish('b', 'x', { qos: 1, signal: controller.signal });
  const outcomes = Promise.allSettled([first, queued]);
  try {
    expect(timer).not.toHaveBeenCalled();
    await expect(broker.client.publish('c', 'x', qosOne)).rejects.toThrow('MQTT publication capacity exceeded');
    controller.abort(reason);
    await expect(queued).rejects.toBe(reason);
    const third = broker.client.publish('c', 'x', qosOne);
    const result = Promise.allSettled([third]);
    try {
      broker.receive({ cmd: 'puback', messageId: 1 });
      await first;
      expect(broker.published()[1]).toMatchObject({ qos: 1, messageId: 2, topic: 'c' });
      broker.receive({ cmd: 'puback', messageId: 2 });
      await third;
    } finally {
      broker.retire(new Error('fixture ended'));
      await result;
    }
  } finally {
    timer.mockRestore();
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});

test('abort after dispatch rejects the caller and retains quota and bytes until PUBACK', async () => {
  const broker = await peer({ receiveMaximum: 1 }, { maxPendingPublishes: 2 });
  const controller = new AbortController();
  const reason = new Error('stop waiting');
  const first = broker.client.publish('a', 'x', { qos: 1, signal: controller.signal });
  const second = broker.client.publish('b', 'x', qosOne);
  const outcomes = Promise.allSettled([first, second]);
  try {
    controller.abort(reason);
    await expect(first).rejects.toBe(reason);
    await expect(broker.client.publish('c', 'x')).rejects.toThrow('MQTT publication capacity exceeded');
    await setImmediate();
    expect(broker.published()).toHaveLength(1);
    broker.receive({ cmd: 'puback', messageId: 1 });
    await vi.waitFor(() => {
      expect(broker.published()[1]).toMatchObject({ qos: 1, messageId: 2, topic: 'b' });
    });
    broker.receive({ cmd: 'puback', messageId: 2 });
    await second;
  } finally {
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});

test('uncertain send failure retires active and queued publications even after an early PUBACK', async () => {
  const broker = await peer({ receiveMaximum: 1 });
  const write = gate();
  const original = broker.transport.send.bind(broker.transport);
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The held send forwards the fixture's mutable transport packet.
  broker.transport.send = async (packet) => {
    await original(packet);
    if (packet.cmd === 'publish') await write.promise;
  };
  const close = vi.spyOn(broker.transport, 'close');
  const first = broker.client.publish('a', 'x', qosOne);
  const second = broker.client.publish('b', 'x', qosOne);
  const outcomes = Promise.allSettled([first, second]);
  const failure = new Error('write uncertain');
  try {
    broker.receive({ cmd: 'puback', messageId: 1 });
    write.reject(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    await expect(broker.client.ping()).rejects.toBe(failure);
    expect(broker.published()).toHaveLength(1);
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    write.release();
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});

test('disconnect fences queued dispatch before sending DISCONNECT', async () => {
  const broker = await peer({ receiveMaximum: 1 });
  const closeWrite = gate();
  const original = broker.transport.send.bind(broker.transport);
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture holds the actual DISCONNECT send.
  broker.transport.send = async (packet) => {
    await original(packet);
    if (packet.cmd === 'disconnect') await closeWrite.promise;
  };
  const first = broker.client.publish('a', 'x', qosOne);
  const second = broker.client.publish('b', 'x', qosOne);
  const outcomes = Promise.allSettled([first, second]);
  try {
    broker.receive({ cmd: 'puback', messageId: 1 });
    const closing = broker.client.disconnect();
    const closed = Promise.allSettled([closing]);
    try {
      await setImmediate();
      expect(broker.published()).toHaveLength(1);
      await expect(second).rejects.toThrow('Client is closing');
      closeWrite.release();
      await closing;
    } finally {
      closeWrite.release();
      await closed;
    }
  } finally {
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});

test('wrong-kind and unmatched acknowledgments leave a sent QoS 1 publication pending', async () => {
  const broker = await peer({ receiveMaximum: 1 });
  const first = broker.client.publish('a', 'x', qosOne);
  const second = broker.client.publish('b', 'x', qosOne);
  const outcomes = Promise.allSettled([first, second]);
  try {
    await setImmediate();
    broker.receive({ cmd: 'suback', messageId: 1, granted: [0] });
    broker.receive({ cmd: 'puback', messageId: 99 });
    await setImmediate();
    expect(broker.published()).toHaveLength(1);
    broker.receive({ cmd: 'puback', messageId: 1 });
    await first;
    expect(broker.published()).toHaveLength(2);
    broker.receive({ cmd: 'puback', messageId: 2 });
    await second;
  } finally {
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});

test('an early PUBACK does not stop the deadline while the actual write is held', async () => {
  const broker = await peer({ receiveMaximum: 1 }, { timeoutMs: 100 });
  const write = gate();
  broker.transport.send = async () => write.promise;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let failure: unknown;
  const first = broker.client.publish('a', 'x', qosOne).catch((reason: unknown) => {
    failure = reason;
  });
  try {
    broker.receive({ cmd: 'puback', messageId: 1 });
    await setImmediate();
    vi.advanceTimersByTime(100);
    await setImmediate();
    expect(failure).toMatchObject({ message: 'MQTT operation timed out' });
  } finally {
    write.release();
    broker.retire(new Error('fixture ended'));
    await first;
    vi.useRealTimers();
  }
});

test('broker Maximum QoS zero rejects QoS 1 before sending and permits QoS 0', async () => {
  const broker = await peer({ maximumQoS: 0 });
  await expect(broker.client.publish('a', 'x', qosOne)).rejects.toThrow('Broker does not support QoS 1');
  expect(broker.published()).toEqual([]);
  await broker.client.publish('a', 'x');
  expect(broker.published()).toEqual([expect.objectContaining({ qos: 0 })]);
  await broker.client.disconnect();
});

test.each([0, 65_536, 1.5, NaN])('rejects invalid CONNACK Receive Maximum %s', async (receiveMaximum) => {
  await expect(peer({ receiveMaximum })).rejects.toThrow('Invalid broker Receive Maximum');
});

test('pre-aborted QoS 1 publish consumes no capacity or packet identifier', async () => {
  const broker = await peer({ receiveMaximum: 1 });
  const reason = new Error('already aborted');
  await expect(broker.client.publish('a', 'x', { qos: 1, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
  const next = broker.client.publish('a', 'x', qosOne);
  const outcome = Promise.allSettled([next]);
  try {
    expect(broker.published()).toEqual([expect.objectContaining({ qos: 1, messageId: 1 })]);
    broker.receive({ cmd: 'puback', messageId: 1 });
    await next;
  } finally {
    broker.retire(new Error('fixture ended'));
    await outcome;
  }
});

test('holds actual-send bytes through terminal cleanup and removes the cancellation listener promptly', async () => {
  const broker = await peer({ receiveMaximum: 1 });
  const write = gate();
  const controller = new AbortController();
  const removed = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
  broker.transport.send = async () => write.promise;
  const released = vi.fn<() => void>();
  // oxlint-disable-next-line typescript/unbound-method -- The spy forwards the original method with its original receiver.
  const reserve = PublicationAdmission.prototype.reserve;
  const admission = vi.spyOn(PublicationAdmission.prototype, 'reserve').mockImplementation(function (
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The original reservation updates the real budget.
    this: PublicationAdmission,
    topic,
    payload,
    qos,
  ) {
    const release = reserve.call(this, topic, payload, qos);
    return () => {
      released();
      release();
    };
  });
  const publication = broker.client.publish('a', 'x', { qos: 1, signal: controller.signal });
  const outcome = Promise.allSettled([publication]);
  try {
    const terminal = new Error('close before drain');
    broker.retire(terminal);
    await expect(publication).rejects.toBe(terminal);
    await setImmediate();
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(released).not.toHaveBeenCalled();
    write.release();
    await setImmediate();
    expect(released).toHaveBeenCalledTimes(1);
  } finally {
    removed.mockRestore();
    admission.mockRestore();
    write.release();
    await outcome;
  }
});

test('allocates before synchronous acknowledgments and keeps reentrant dispatch in FIFO order', async () => {
  const broker = await peer({ receiveMaximum: 2 });
  const original = broker.transport.send.bind(broker.transport);
  let nested: Promise<void> | undefined;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The reentrant fixture forwards the same mutable packet.
  broker.transport.send = async (packet) => {
    if (packet.cmd === 'publish' && packet.topic === 'first') {
      nested = broker.client.publish('second', 'x', qosOne);
    }
    const sent = original(packet);
    if (packet.cmd === 'publish') broker.receive({ cmd: 'puback', messageId: packet.messageId });
    await sent;
  };
  const first = broker.client.publish('first', 'x', qosOne);
  try {
    await Promise.all([first, nested]);
    expect(broker.published()).toMatchObject([
      { topic: 'first', messageId: 1 },
      { topic: 'second', messageId: 2 },
    ]);
  } finally {
    broker.retire(new Error('fixture ended'));
  }
});

test('rejects a local publication when all shared IDs are held and can retry after release', async () => {
  const broker = await peer({ receiveMaximum: 1 });
  // oxlint-disable-next-line typescript/unbound-method -- Forward the original allocator with its receiver to fill the actual shared namespace.
  const reserve = PacketIdentifiers.prototype.reserve;
  const held: ReturnType<PacketIdentifiers['reserve']>[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture reserves IDs in the same mutable allocator as the session.
  const allocator = vi.spyOn(PacketIdentifiers.prototype, 'reserve').mockImplementation(function (this: PacketIdentifiers) {
    for (let index = 0; index < 65_535; index++) held.push(reserve.call(this));
    return reserve.call(this);
  });
  try {
    await expect(broker.client.publish('a', 'x', qosOne)).rejects.toThrow('MQTT packet identifiers exhausted');
    expect(broker.published()).toEqual([]);
    allocator.mockRestore();
    held[1]!.release();
    const retried = broker.client.publish('a', 'x', qosOne);
    const outcome = Promise.allSettled([retried]);
    try {
      expect(broker.published()[0]).toMatchObject({ messageId: 2, qos: 1 });
      broker.receive({ cmd: 'suback', messageId: 2, granted: [0] });
      broker.receive({ cmd: 'puback', messageId: 2 });
      await retried;
    } finally {
      broker.retire(new Error('fixture ended'));
      await outcome;
    }
  } finally {
    allocator.mockRestore();
    for (const identifier of held) identifier.release();
  }
});

test('queued abort survives a caller listener stopping propagation', async () => {
  const broker = await peer({ receiveMaximum: 1 });
  const controller = new AbortController();
  controller.signal.addEventListener('abort', (event: Readonly<Pick<Event, 'stopImmediatePropagation'>>) => {
    event.stopImmediatePropagation();
  });
  const reason = new Error('cancel even when a listener stops propagation');
  const first = broker.client.publish('a', 'x', qosOne);
  let rejected: unknown;
  const queued = broker.client.publish('b', 'x', { qos: 1, signal: controller.signal }).catch((error: unknown) => {
    rejected = error;
  });
  const outcomes = Promise.allSettled([first, queued]);
  try {
    controller.abort(reason);
    await setImmediate();
    expect(rejected).toBe(reason);
    broker.receive({ cmd: 'puback', messageId: 1 });
    await first;
    expect(broker.published()).toHaveLength(1);
  } finally {
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});

test.each([
  { messageId: 0, reasonCode: 0, error: 'Invalid PUBACK packet identifier' },
  { messageId: 1, reasonCode: 0x81, error: 'Invalid PUBACK reason code' },
])(
  'retires on malformed PUBACK before releasing quota',
  async ({ messageId, reasonCode, error }: Readonly<{ messageId: number; reasonCode: number; error: string }>) => {
    const broker = await peer({ receiveMaximum: 1 });
    const first = broker.client.publish('a', 'x', qosOne);
    const second = broker.client.publish('b', 'x', qosOne);
    const outcomes = Promise.allSettled([first, second]);
    try {
      broker.receive({ cmd: 'puback', messageId, reasonCode });
      await expect(first).rejects.toThrow(error);
      await expect(second).rejects.toThrow(error);
      expect(broker.published()).toHaveLength(1);
    } finally {
      broker.retire(new Error('fixture ended'));
      await outcomes;
    }
  },
);

test('snapshots broker limits before the transport can mutate the CONNACK object', async () => {
  const properties = { receiveMaximum: 1, maximumQoS: 1 };
  const broker = await peer(properties, undefined, () => {
    properties.receiveMaximum = 2;
    properties.maximumQoS = 0;
  });
  const first = broker.client.publish('a', 'x', qosOne);
  const second = broker.client.publish('b', 'x', qosOne);
  const outcomes = Promise.allSettled([first, second]);
  try {
    expect(broker.published()).toHaveLength(1);
    broker.receive({ cmd: 'puback', messageId: 1 });
    await first;
    expect(broker.published()).toHaveLength(2);
    broker.receive({ cmd: 'puback', messageId: 2 });
    await second;
  } finally {
    broker.retire(new Error('fixture ended'));
    await outcomes;
  }
});

test.each(['é'.repeat(60) + 'a', 'é'.repeat(61)])(
  'charges encoded QoS 1 bytes across the Remaining Length boundary',
  async (payload) => {
    const bytes = generate(
      { cmd: 'publish', topic: 'a', payload, qos: 1, messageId: 1, dup: false, retain: false },
      { protocolVersion: 5 },
    ).length;
    const small = await peer(undefined, { maxPendingPublishBytes: bytes - 1 });
    await expect(small.client.publish('a', payload, qosOne)).rejects.toThrow('MQTT publication capacity exceeded');
    expect(small.published()).toEqual([]);
    await small.client.disconnect();
    const exact = await peer(undefined, { maxPendingPublishBytes: bytes });
    const published = exact.client.publish('a', payload, qosOne);
    const outcome = Promise.allSettled([published]);
    try {
      expect(exact.published()).toHaveLength(1);
      exact.receive({ cmd: 'puback', messageId: 1 });
      await published;
    } finally {
      exact.retire(new Error('fixture ended'));
      await outcome;
    }
  },
);
