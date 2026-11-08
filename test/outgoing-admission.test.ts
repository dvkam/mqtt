import type { Packet } from 'mqtt-packet';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
import { connectPortable, type PacketTransport } from '../src/portable.js';
import { PublicationAdmission } from '../src/publicationAdmission.js';

function peer() {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The scripted peer retains the packet transport callback contract.
  let receive: (packet: Packet) => void;
  const sent: string[] = [];
  const writes: { resolve: () => void; reject: (error: Readonly<Error>) => void }[] = [];
  const transport: PacketTransport = {
    listen(onPacket) {
      receive = onPacket;
      return () => {};
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native packet shapes remain mutable at the transport boundary.
    async send(packet) {
      sent.push(packet.cmd);
      if (packet.cmd === 'publish')
        return new Promise<void>((resolve, reject) => {
          writes.push({ resolve, reject });
        });
      if (packet.cmd === 'connect') receive({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
      if (packet.cmd === 'pingreq') receive({ cmd: 'pingresp' });
      if (packet.cmd === 'subscribe') receive({ cmd: 'suback', messageId: packet.messageId, granted: [0] });
    },
    async close() {},
  };
  return { transport, sent, writes };
}

test('rejects excess items before sending and preserves control capacity and reuse', async () => {
  const broker = peer();
  const options = { clientId: 'admission', maxPendingPublishes: 1, maxPendingPublishBytes: 100 };
  const client = await connectPortable(broker.transport, options);
  const first = client.publish('a', 'one').catch((reason: unknown) => reason);
  const excess = client.publish('a', 'two').catch((reason: unknown) => reason);
  expect(broker.writes).toHaveLength(1);
  await expect(excess).resolves.toMatchObject({ message: 'MQTT publication capacity exceeded' });
  await client.ping();
  await client.subscribe('a');
  broker.writes[0]!.resolve();
  await first;
  const next = client.publish('a', 'one');
  broker.writes[1]!.resolve();
  await next;
  await client.disconnect();
  expect(broker.sent).toEqual(['connect', 'publish', 'pingreq', 'subscribe', 'publish', 'disconnect']);
});

test.each([
  ['a', '', 6],
  ['é', '😀', 11],
  ['a', 'x'.repeat(124), 131],
] as const)('counts exact MQTT wire bytes for topic %s', async (topic, payload, bytes) => {
  const broker = peer();
  const options = { clientId: 'bytes', maxPendingPublishes: 3, maxPendingPublishBytes: bytes };
  const client = await connectPortable(broker.transport, options);
  const first = client.publish(topic, payload).catch((reason: unknown) => reason);
  const excess = client.publish('a', '').catch((reason: unknown) => reason);
  expect(broker.writes).toHaveLength(1);
  await expect(excess).resolves.toMatchObject({ message: 'MQTT publication capacity exceeded' });
  broker.writes[0]!.resolve();
  await first;
  await client.disconnect();
});

test.each(['resolve', 'reject', 'throw'] as const)('releases reservations when send will %s', async (outcome) => {
  const broker = peer();
  const client = await connectPortable(broker.transport, {
    clientId: 'release',
    maxPendingPublishes: 1,
    maxPendingPublishBytes: 9,
  });
  const original = broker.transport.send.bind(broker.transport);
  const failure = new Error('send failed');
  if (outcome === 'throw')
    broker.transport.send = () => {
      throw failure;
    };
  const first = client.publish('a', 'one').catch((reason: unknown) => reason);
  if (outcome === 'resolve') broker.writes[0]!.resolve();
  if (outcome === 'reject') broker.writes[0]!.reject(failure);
  expect(await first).toBe(outcome === 'resolve' ? undefined : failure);
  broker.transport.send = original;
  const next = client.publish('a', 'one');
  broker.writes[broker.writes.length - 1]!.resolve();
  await next;
  await client.disconnect();
});

test('default item limit rejects a burst before another send', async () => {
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'default-items' });
  const pending = Array.from({ length: 32 }, async () => client.publish('a', ''));
  await expect(client.publish('a', '')).rejects.toThrow('MQTT publication capacity exceeded');
  expect(broker.writes).toHaveLength(32);
  for (const write of broker.writes) write.resolve();
  await Promise.all(pending);
  await client.disconnect();
});

test.each(['\uD800', '\uDC00', '😀', 'é', 'a'.repeat(16_380)])('matches encoded wire size for payload %s', async (payload) => {
  const body = new TextEncoder().encode(payload).length + 4;
  let length = 1;
  for (let value = body; value >= 128; value = Math.floor(value / 128)) length++;
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'utf8', maxPendingPublishBytes: 1 + length + body });
  const first = client.publish('a', payload);
  await expect(client.publish('a', '')).rejects.toThrow('MQTT publication capacity exceeded');
  broker.writes[0]!.resolve();
  await first;
  await client.disconnect();
});

test('reserves before reentrant transport work and snapshots configuration', async () => {
  const broker = peer();
  const options = { clientId: 'reentrant', maxPendingPublishes: 1 };
  const client = await connectPortable(broker.transport, options);
  options.maxPendingPublishes = 100;
  const original = broker.transport.send.bind(broker.transport);
  let nested: Promise<unknown> | undefined;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The scripted send keeps its mutable transport packet contract.
  broker.transport.send = async (packet) => {
    if (packet.cmd === 'publish') nested = client.publish('a', 'nested').catch((reason: unknown) => reason);
    await original(packet);
  };
  const pending = client.publish('a', 'first');
  await expect(nested).resolves.toMatchObject({ message: 'MQTT publication capacity exceeded' });
  expect(broker.writes).toHaveLength(1);
  broker.writes[0]!.resolve();
  await pending;
  await client.disconnect();
});

test('timeout keeps the reservation until the actual send settles', async () => {
  // oxlint-disable-next-line typescript/unbound-method -- The spy forwards the original instance method with its captured receiver.
  const reserve = PublicationAdmission.prototype.reserve;
  const released = vi.fn<() => void>();
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The ownership spy must forward the original mutable class receiver.
  vi.spyOn(PublicationAdmission.prototype, 'reserve').mockImplementation(function (this: PublicationAdmission, topic, payload) {
    const release = reserve.call(this, topic, payload);
    return () => {
      released();
      release();
    };
  });
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'timeout-reservation', timeoutMs: 100 });
  const pending = client.publish('a', 'held').catch((reason: unknown) => reason);
  vi.advanceTimersByTime(100);
  expect(await pending).toMatchObject({ message: 'MQTT operation timed out' });
  expect(released).not.toHaveBeenCalled();
  broker.writes[0]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(released).toHaveBeenCalledTimes(1);
});

test('default byte limit rejects an oversized publication before transport send or timer', async () => {
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'default-bytes' });
  const timer = vi.spyOn(globalThis, 'setTimeout');
  await expect(client.publish('a', 'x'.repeat(1024 * 1024))).rejects.toThrow('MQTT publication capacity exceeded');
  expect(broker.writes).toHaveLength(0);
  expect(timer).not.toHaveBeenCalled();
  await client.disconnect();
});
