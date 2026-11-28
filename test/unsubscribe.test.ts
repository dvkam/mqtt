import { setImmediate } from 'node:timers/promises';
import { generate } from 'mqtt-packet';
import { expect, test, vi } from 'vitest';
import { encodePacket, PacketDecoder, type ClientPacket } from '../src/codec.js';
import { PacketIdentifiers } from '../src/packetIdentifiers.js';
import { connectPortable, type PacketTransport, type PortableOptions } from '../src/portable.js';
import type { ReadonlyDeep } from '../src/util/bytes.js';

/** The scripted transport. Its `send` only reads the packet, so an override may forward the read-only view to it. */
type ReadingTransport = Omit<PacketTransport, 'send'> & { send: (packet: ReadonlyDeep<ClientPacket>) => Promise<void> };

test('encodes UNSUBSCRIBE without subscription option bytes and decodes split frames', () => {
  const packet = { cmd: 'unsubscribe', messageId: 1, topics: ['a', 'b'] } as const;
  const bytes = Uint8Array.of(0xa2, 9, 0, 1, 0, 0, 1, 97, 0, 1, 98);
  expect(encodePacket(packet)).toEqual(bytes);
  expect(generate({ cmd: 'unsubscribe', messageId: 1, unsubscriptions: ['a', 'b'] }, { protocolVersion: 5 })).toEqual(
    Buffer.from(bytes),
  );
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new PacketDecoder();
    expect([...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))]).toEqual([packet]);
  }
});

test('encodes UNSUBACK with mandatory properties length and a reason per filter', () => {
  const packet = { cmd: 'unsuback', messageId: 1, granted: [0, 17, 0x8f], reasonString: 'r' } as const;
  const bytes = Uint8Array.of(0xb0, 10, 0, 1, 4, 0x1f, 0, 1, 114, 0, 17, 0x8f);
  expect(encodePacket(packet)).toEqual(bytes);
  expect(new PacketDecoder().push(bytes)).toEqual([packet]);
  expect(encodePacket({ cmd: 'unsuback', messageId: 1, granted: [17] })).toEqual(Uint8Array.of(0xb0, 4, 0, 1, 0, 17));
});

test.each([
  { bytes: [0xa0, 0], reason: 'invalid fixed-header flags' },
  { bytes: [0xb2, 0], reason: 'invalid fixed-header flags' },
  { bytes: [0xa2, 3, 0, 0, 0], reason: 'MQTT integer out of range' },
  { bytes: [0xa2, 3, 0, 1, 0], reason: 'Empty UNSUBSCRIBE' },
  { bytes: [0xb0, 2, 0, 1], reason: 'Truncated MQTT UNSUBACK property' },
  { bytes: [0xb0, 3, 0, 1, 0], reason: 'Invalid UNSUBACK' },
  { bytes: [0xb0, 4, 0, 1, 0, 1], reason: 'Invalid UNSUBACK' },
])(
  'rejects malformed unsubscribe wire bytes $bytes',
  ({ bytes, reason }: Readonly<{ bytes: readonly number[]; reason: string }>) => {
    const decoder = new PacketDecoder();
    expect(() => decoder.push(Uint8Array.from(bytes))).toThrow(reason);
    expect(() => decoder.push(Uint8Array.of(0xd0, 0))).toThrow(reason);
  },
);

async function peer(limits: Readonly<Pick<PortableOptions, 'maxPendingSubscriptions' | 'maxPendingSubscriptionBytes'>> = {}) {
  let receive!: Parameters<PacketTransport['listen']>[0];
  let retire!: Parameters<PacketTransport['listen']>[1];
  const packets: ReadonlyDeep<ClientPacket>[] = [];
  const transport: ReadingTransport = {
    async send(packet: ReadonlyDeep<ClientPacket>) {
      packets.push(packet);
      if (packet.cmd === 'connect') receive({ cmd: 'connack', reasonCode: 0, sessionPresent: false, receiveMaximum: 1 });
      if (packet.cmd === 'pingreq') receive({ cmd: 'pingresp' });
      return Promise.resolve();
    },
    listen(onPacket, onClose) {
      receive = onPacket;
      retire = onClose;
      return () => {};
    },
    async close() {},
  };
  const client = await connectPortable(transport, { clientId: 'unsubscribe-tracer', ...limits });
  return { client, transport, packets, receive, retire };
}

test('preserves mixed-kind ACK ownership when the shared identifier range is exhausted', async () => {
  const broker = await peer();
  expect(typeof broker.client.unsubscribe).toBe('function');
  const completed: string[] = [];
  // oxlint-disable-next-line typescript/unbound-method -- Removing it would cost developer experience. The spy forwards to the original `PacketIdentifiers.reserve` with `reserve.call(this)`, which needs the method without a receiver. The form the rule accepts for that read is `Reflect.get`, which returns `any`, so the forwarded call would lose its receiver and result types.
  const reserve = PacketIdentifiers.prototype.reserve;
  const held: ReturnType<PacketIdentifiers['reserve']>[] = [];
  const allocator = vi.spyOn(PacketIdentifiers.prototype, 'reserve').mockImplementation(function (
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The spy calls the original `PacketIdentifiers.reserve` on `this` with `reserve.call(this)`, and `reserve` changes the object it is called on, which is the state this test fills. The rule accepts only a read-only type, and that would be false for this parameter.
    this: PacketIdentifiers,
  ) {
    const lease = reserve.call(this);
    if (lease.messageId === 3) {
      for (let index = 3; index < 65_535; index++) held.push(reserve.call(this));
    }
    return lease;
  });
  const subscribed = broker.client.subscribe('a').then(() => {
    completed.push('subscribe');
  });
  const published = broker.client.publish('b', 'value', { qos: 1 }).then(() => {
    completed.push('publish');
  });
  const unsubscribed = broker.client.unsubscribe('c').then(() => {
    completed.push('unsubscribe');
  });
  const queued = broker.client.publish('d', 'next', { qos: 1 }).then(() => {
    completed.push('queued');
  });
  const outcomes = Promise.allSettled([subscribed, published, unsubscribed, queued]);
  try {
    allocator.mockRestore();
    expect(held).toHaveLength(65_532);
    await expect(broker.client.subscribe('e')).rejects.toMatchObject({
      message: 'MQTT packet identifiers exhausted',
      code: 'ERR_MQTT_CAPACITY',
    });
    expect(broker.packets.slice(1)).toMatchObject([
      { cmd: 'subscribe', messageId: 1 },
      { cmd: 'publish', messageId: 2, qos: 1 },
      { cmd: 'unsubscribe', messageId: 3, topics: ['c'] },
    ]);
    await setImmediate();
    broker.receive({ cmd: 'unsuback', messageId: 1, granted: [0] });
    broker.receive({ cmd: 'puback', messageId: 3, reasonCode: 0 });
    broker.receive({ cmd: 'suback', messageId: 3, granted: [0] });
    broker.receive({ cmd: 'suback', messageId: 2, granted: [0] });
    await setImmediate();
    expect(completed).toEqual([]);
    expect(broker.packets).toHaveLength(4);
    broker.receive({ cmd: 'unsuback', messageId: 3, granted: [17] });
    await unsubscribed;
    broker.receive({ cmd: 'puback', messageId: 2, reasonCode: 0 });
    await published;
    await setImmediate();
    expect(broker.packets[4]).toMatchObject({ cmd: 'publish', messageId: 2, topic: 'd' });
    broker.receive({ cmd: 'puback', messageId: 2, reasonCode: 0 });
    await queued;
    broker.receive({ cmd: 'suback', messageId: 1, granted: [0] });
    await subscribed;
    expect(completed).toEqual(['unsubscribe', 'publish', 'queued', 'subscribe']);
  } finally {
    allocator.mockRestore();
    broker.retire(new Error('fixture ended'));
    for (const lease of held) lease.release();
    await outcomes;
  }
});

test.each([
  { maxPendingSubscriptions: 2, maxPendingSubscriptionBytes: 1024 },
  { maxPendingSubscriptions: 4, maxPendingSubscriptionBytes: 17 },
])(
  'shares subscription admission until both UNSUBACK and send settle',
  async (limits: Readonly<Pick<PortableOptions, 'maxPendingSubscriptions' | 'maxPendingSubscriptionBytes'>>) => {
    const broker = await peer(limits);
    expect(typeof broker.client.unsubscribe).toBe('function');
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const original = broker.transport.send.bind(broker.transport);
    broker.transport.send = async (packet: ReadonlyDeep<ClientPacket>) => {
      await original(packet);
      if (packet.cmd === 'unsubscribe') await held;
    };
    const unsubscribed = broker.client.unsubscribe('a');
    const subscribed = broker.client.subscribe('b');
    const outcomes = Promise.allSettled([unsubscribed, subscribed]);
    try {
      expect(broker.packets.slice(1)).toMatchObject([
        { cmd: 'unsubscribe', messageId: 1 },
        { cmd: 'subscribe', messageId: 2 },
      ]);
      broker.receive({ cmd: 'unsuback', messageId: 1, granted: [0] });
      await setImmediate();
      await expect(broker.client.unsubscribe('c')).rejects.toMatchObject({
        message: 'MQTT subscription capacity exceeded',
        code: 'ERR_MQTT_CAPACITY',
      });
      release();
      await unsubscribed;
      broker.receive({ cmd: 'suback', messageId: 2, granted: [0] });
      await subscribed;
    } finally {
      release();
      broker.retire(new Error('fixture ended'));
      await outcomes;
    }
  },
);

test('validates unsubscribe filters locally and preserves a broker refusal', async () => {
  const broker = await peer();
  expect(typeof broker.client.unsubscribe).toBe('function');
  await expect(broker.client.unsubscribe('a/#/b')).rejects.toMatchObject({
    message: 'Invalid MQTT topic filter',
    code: 'ERR_MQTT_INVALID_ARGUMENT',
  });
  const first = broker.client.unsubscribe('a');
  broker.receive({ cmd: 'unsuback', messageId: 1, granted: [0x87] });
  await expect(first).rejects.toMatchObject({ code: 'ERR_MQTT_REFUSED', reasonCode: 0x87 });
  await broker.client.ping();
  await broker.client.disconnect();
});

test('rejects an unsubscribe one byte below its complete encoded size', async () => {
  const broker = await peer({ maxPendingSubscriptionBytes: 7 });
  await expect(broker.client.unsubscribe('a')).rejects.toMatchObject({
    message: 'MQTT subscription capacity exceeded',
    code: 'ERR_MQTT_CAPACITY',
  });
  expect(broker.packets).toHaveLength(1);
  await broker.client.ping();
  await broker.client.disconnect();
});

test('preserves shared-filter spelling for transports that can encode it', async () => {
  const broker = await peer();
  const filter = '$share/group/a';
  const pending = broker.client.unsubscribe(filter);
  const outcome = Promise.allSettled([pending]);
  try {
    expect(broker.packets[1]).toMatchObject({ cmd: 'unsubscribe', messageId: 1, topics: [filter] });
    broker.receive({ cmd: 'unsuback', messageId: 1, granted: [0] });
    await pending;
  } finally {
    broker.retire(new Error('fixture ended'));
    await outcome;
  }
});
