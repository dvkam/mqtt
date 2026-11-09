import { setImmediate } from 'node:timers/promises';
import { generate, type IPublishPacket, type Packet } from 'mqtt-packet';
import { expect, test, vi } from 'vitest';
import { encodePacket, PacketDecoder } from '../src/codec.js';
import { connectPortable, type PacketTransport, type PortableOptions } from '../src/portable.js';

test('encodes and parses CONNECT Receive Maximum and QoS 1 SUBSCRIBE', () => {
  const connect = Uint8Array.of(0x10, 17, 0, 4, 77, 81, 84, 84, 5, 2, 0, 0, 3, 0x21, 0, 1, 0, 1, 97);
  expect(encodePacket({ cmd: 'connect', clientId: 'a', receiveMaximum: 1 })).toEqual(connect);
  expect(new PacketDecoder().push(connect)).toEqual([
    { cmd: 'connect', clientId: 'a', cleanStart: true, keepAlive: 0, receiveMaximum: 1 },
  ]);
  const subscribe = Uint8Array.of(0x82, 7, 0, 1, 0, 0, 1, 97, 1);
  expect(encodePacket({ cmd: 'subscribe', messageId: 1, topics: ['a'], qos: 1 })).toEqual(subscribe);
  expect(new PacketDecoder().push(subscribe)).toEqual([{ cmd: 'subscribe', messageId: 1, topics: ['a'], qos: 1 }]);
  expect(generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: 'a', qos: 1 }] }, { protocolVersion: 5 })).toEqual(
    Buffer.from(subscribe),
  );
});

test.each([
  {
    bytes: [0x10, 17, 0, 4, 77, 81, 84, 84, 5, 2, 0, 0, 3, 0x21, 0, 0, 0, 1, 97],
    reason: 'MQTT integer out of range',
  },
  {
    bytes: [0x10, 20, 0, 4, 77, 81, 84, 84, 5, 2, 0, 0, 6, 0x21, 0, 1, 0x21, 0, 1, 0, 1, 97],
    reason: 'Invalid Receive Maximum property',
  },
  { bytes: [0x82, 7, 0, 1, 0, 0, 1, 97, 2], reason: 'Unsupported subscription options' },
  {
    bytes: [0x82, 11, 0, 1, 0, 0, 1, 97, 0, 0, 1, 98, 1],
    reason: 'Unsupported subscription options',
  },
])(
  'rejects invalid inbound QoS 1 wire settings $bytes',
  ({ bytes, reason }: Readonly<{ bytes: readonly number[]; reason: string }>) => {
    expect(() => new PacketDecoder().push(Uint8Array.from(bytes))).toThrow(reason);
  },
);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
}

async function peer(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Options retain callbacks with mutable packet payloads.
  options: Readonly<Partial<PortableOptions>>,
  acknowledgment?: Readonly<Promise<void>>,
  grant = 1,
  disconnectWrite?: Readonly<Promise<void>>,
) {
  let receive!: Parameters<PacketTransport['listen']>[0];
  let retire!: Parameters<PacketTransport['listen']>[1];
  const sent: Packet[] = [];
  const closes: Array<boolean | undefined> = [];
  const transport: PacketTransport = {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The scripted peer records the original packet and may reply during send.
    async send(packet) {
      sent.push(packet);
      if (packet.cmd === 'connect') receive({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
      if (packet.cmd === 'subscribe') receive({ cmd: 'suback', messageId: packet.messageId, granted: [grant] });
      if (packet.cmd === 'pingreq') receive({ cmd: 'pingresp' });
      if (packet.cmd === 'puback') await acknowledgment;
      if (packet.cmd === 'disconnect') await disconnectWrite;
    },
    listen(onPacket, onClose) {
      receive = onPacket;
      retire = onClose;
      return () => {};
    },
    async close(force) {
      closes.push(force);
      await Promise.resolve();
    },
  };
  return {
    client: await connectPortable(transport, { clientId: 'receive-qos1', ...options }),
    receive,
    retire,
    sent,
    closes,
  };
}

function publication(messageId: number, dup = false): IPublishPacket & { qos: 1; messageId: number; dup: boolean } {
  return {
    cmd: 'publish',
    qos: 1,
    messageId,
    dup,
    retain: false,
    topic: 'a',
    payload: Buffer.from('hello'),
  };
}

test.each([0, 1])('advertises one inbound slot and accepts SUBACK grant %i', async (grant) => {
  const broker = await peer({ onQosOneMessage() {} }, undefined, grant);
  expect(broker.sent[0]).toMatchObject({ cmd: 'connect', properties: { receiveMaximum: 1 } });
  await broker.client.subscribe('a', { qos: 1 });
  expect(broker.sent[1]).toMatchObject({
    cmd: 'subscribe',
    subscriptions: [{ topic: 'a', qos: 1 }],
  });
  await broker.client.disconnect();
});

test('rejects a QoS 1 subscription locally without a handler', async () => {
  const broker = await peer({}, undefined, 0);
  expect(broker.sent[0]).not.toHaveProperty('properties');
  await expect(broker.client.subscribe('a', { qos: 1 })).rejects.toThrow('QoS 1 subscription requires onQosOneMessage');
  expect(broker.sent).toHaveLength(1);
  await broker.client.ping();
  await broker.client.subscribe('a');
  expect(broker.sent[2]).toMatchObject({
    cmd: 'subscribe',
    messageId: 1,
    subscriptions: [{ topic: 'a', qos: 0 }],
  });
  await broker.client.disconnect();
});

test('keeps inbound ownership separate and waits for application success before PUBACK', async () => {
  const handler = gate();
  const delivered: number[] = [];
  const qosZero: string[] = [];
  const broker = await peer({
    onMessage(message: Readonly<{ topic: string }>) {
      qosZero.push(message.topic);
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Mutate the delivered packet to test that the session keeps its own ACK identifier.
    async onQosOneMessage(message) {
      delivered.push(message.messageId);
      message.messageId = 99;
      expect(message.payload).toEqual(Buffer.from('hello'));
      await handler.promise;
    },
  });
  const published = broker.client.publish('b', 'outbound', { qos: 1 });
  const settled = Promise.allSettled([published]);
  try {
    expect(broker.sent[1]).toMatchObject({ cmd: 'publish', messageId: 1 });
    broker.receive(publication(1));
    broker.receive({ ...publication(2), qos: 0, topic: 'qos-zero' });
    await broker.client.ping();
    expect(delivered).toEqual([1]);
    expect(qosZero).toEqual(['qos-zero']);
    expect(broker.sent.some((packet: Readonly<{ cmd: string }>) => packet.cmd === 'puback')).toBe(false);
    broker.receive({ cmd: 'puback', messageId: 1 });
    await published;
    handler.release();
    await setImmediate();
    expect(broker.sent[broker.sent.length - 1]).toMatchObject({ cmd: 'puback', messageId: 1, reasonCode: 0 });
  } finally {
    handler.release();
    broker.retire(new Error('fixture ended'));
    await settled;
  }
});

test('holds one next PUBLISH during ACK write settlement and delivers a reused ID as a new message', async () => {
  const acknowledged = gate();
  const delivered: boolean[] = [];
  const broker = await peer(
    {
      onQosOneMessage(message: Readonly<{ dup: boolean }>) {
        delivered.push(message.dup);
      },
    },
    acknowledged.promise,
  );
  broker.receive(publication(7));
  await setImmediate();
  expect(broker.sent[broker.sent.length - 1]).toMatchObject({ cmd: 'puback', messageId: 7 });
  broker.receive(publication(7, true));
  await expect(broker.client.ping()).resolves.toBeUndefined();
  expect(delivered).toEqual([false]);
  acknowledged.release();
  await setImmediate();
  expect(delivered).toEqual([false, true]);
  expect(broker.sent.filter((packet: Readonly<{ cmd: string }>) => packet.cmd === 'puback')).toHaveLength(2);
  await broker.client.disconnect();
});

test.each(['handling', 'acknowledging'] as const)('bounds retained inbound messages while %s', async (phase) => {
  const held = gate();
  const received: number[] = [];
  const broker = await peer(
    {
      // oxlint-disable-next-line typescript/promise-function-async -- Reuse the gate so the fixture can hold exactly one phase.
      onQosOneMessage(message: Readonly<{ messageId: number }>) {
        received.push(message.messageId);
        return phase === 'handling' ? held.promise : undefined;
      },
    },
    phase === 'acknowledging' ? held.promise : undefined,
  );
  try {
    broker.receive(publication(1));
    await setImmediate();
    broker.receive(publication(2));
    if (phase === 'acknowledging') broker.receive(publication(3));
    await setImmediate();
    await expect(broker.client.ping()).rejects.toMatchObject({ code: 0x93 });
    expect(broker.sent[broker.sent.length - 1]).toMatchObject({ cmd: 'disconnect', reasonCode: 0x93 });
    expect(broker.closes).toEqual([true]);
    expect(received).toEqual([1]);
  } finally {
    held.release();
  }
  await setImmediate();
  expect(received).toEqual([1]);
});

test('retires on handler rejection and does not send a successful PUBACK', async () => {
  const failure = new Error('handler failed');
  const broker = await peer({
    onQosOneMessage() {
      throw failure;
    },
  });
  broker.receive(publication(7));
  await setImmediate();
  await expect(broker.client.ping()).rejects.toBe(failure);
  expect(broker.sent.some((packet: Readonly<{ cmd: string }>) => packet.cmd === 'puback')).toBe(false);
  expect(broker.closes).toEqual([true]);
});

test.each(['disconnect', 'timeout'] as const)('fences handler completion after %s', async (end) => {
  const held = gate();
  const broker = await peer({
    timeoutMs: 30,
    async onQosOneMessage() {
      await held.promise;
    },
  });
  broker.receive(publication(7));
  if (end === 'disconnect') await broker.client.disconnect();
  await expect.poll(() => broker.closes).toEqual([end === 'disconnect' ? undefined : true]);
  held.release();
  await setImmediate();
  expect(broker.sent.some((packet: Readonly<{ cmd: string }>) => packet.cmd === 'puback')).toBe(false);
  expect(broker.closes).toEqual([end === 'disconnect' ? undefined : true]);
});

test('retains the first QoS 1 PUBLISH arriving with CONNACK while CONNECT send settles', async () => {
  const sent = gate();
  const acks: number[] = [];
  const delivered: number[] = [];
  let receive!: Parameters<PacketTransport['listen']>[0];
  const opening = connectPortable(
    {
      listen(onPacket) {
        receive = onPacket;
        return () => {};
      },
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture forwards mutable packets during the opening send.
      async send(packet) {
        if (packet.cmd === 'connect') {
          receive({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
          receive(publication(7));
          await sent.promise;
        }
        if (packet.cmd === 'puback' && packet.messageId !== undefined) acks.push(packet.messageId);
      },
      async close() {},
    },
    {
      clientId: 'coalesced',
      onQosOneMessage(message: Readonly<{ messageId: number }>) {
        delivered.push(message.messageId);
      },
    },
  );
  expect(delivered).toEqual([]);
  expect(acks).toEqual([]);
  sent.release();
  const client = await opening;
  await setImmediate();
  expect(delivered).toEqual([7]);
  expect(acks).toEqual([7]);
  await client.disconnect();
});

test('bounds the protocol-error report if its transport write stays pending', async () => {
  const held = gate();
  const broker = await peer(
    {
      timeoutMs: 50,
      async onQosOneMessage() {
        await held.promise;
      },
    },
    undefined,
    1,
    held.promise,
  );
  try {
    broker.receive(publication(7));
    broker.receive(publication(8));
    await expect(broker.client.ping()).rejects.toMatchObject({ code: 0x93 });
    await expect.poll(() => broker.closes).toEqual([true]);
    expect(broker.sent[broker.sent.length - 1]).toMatchObject({ cmd: 'disconnect', reasonCode: 0x93 });
  } finally {
    held.release();
  }
});

test('the inbound deadline does not supersede an in-progress graceful disconnect', async () => {
  vi.useFakeTimers();
  const handler = gate();
  const write = gate();
  try {
    const broker = await peer(
      {
        timeoutMs: 50,
        async onQosOneMessage() {
          await handler.promise;
        },
      },
      undefined,
      1,
      write.promise,
    );
    broker.receive(publication(7));
    await vi.advanceTimersByTimeAsync(30);
    const disconnect = broker.client.disconnect();
    const settled = Promise.allSettled([disconnect]);
    try {
      await vi.advanceTimersByTimeAsync(25);
      expect(broker.closes).toEqual([]);
      write.release();
      await disconnect;
      handler.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(broker.closes).toEqual([undefined]);
      expect(broker.sent.map((packet: Readonly<{ cmd: string }>) => packet.cmd)).toEqual(['connect', 'disconnect']);
    } finally {
      write.release();
      await settled;
    }
  } finally {
    handler.release();
    vi.useRealTimers();
  }
});

test('the incoming ACK write failure owns retirement and discards its waiting follower', async () => {
  const failure = new Error('PUBACK send failed');
  let rejectWrite!: (reason: Readonly<Error>) => void;
  const write = new Promise<void>((_resolve, reject) => {
    rejectWrite = reject;
  });
  const delivered: number[] = [];
  const broker = await peer(
    {
      onQosOneMessage(message: Readonly<{ messageId: number }>) {
        delivered.push(message.messageId);
      },
    },
    write,
  );
  broker.receive(publication(7));
  await setImmediate();
  broker.receive(publication(8));
  rejectWrite(failure);
  await setImmediate();
  await expect(broker.client.ping()).rejects.toBe(failure);
  expect(delivered).toEqual([7]);
  expect(broker.closes).toEqual([true]);
});

test('encodes the receive-window error with abbreviated MQTT 5 DISCONNECT', () => {
  const bytes = Uint8Array.of(0xe0, 1, 0x93);
  expect(encodePacket({ cmd: 'disconnect', reasonCode: 0x93 })).toEqual(bytes);
  expect(new PacketDecoder().push(bytes)).toEqual([{ cmd: 'disconnect', reasonCode: 0x93 }]);
  expect(new PacketDecoder().push(Uint8Array.of(0xe0, 2, 0x93, 0))).toEqual([{ cmd: 'disconnect', reasonCode: 0x93 }]);
});
