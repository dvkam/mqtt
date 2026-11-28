import { expect, test, vi } from 'vitest';
import type { ByteInbound, ByteTransport } from '../src/byteTransport.js';
import { encodePacket, PacketDecoder, type ClientPacket } from '../src/codec.js';
import { createTransportClient } from '../src/portableClient.js';
import type { ReadonlyBytes } from '../src/util/bytes.js';

// A broker that sends `maximumPacketSize` in CONNACK and answers PINGREQ, and SUBSCRIBE, UNSUBSCRIBE and QoS 1 PUBLISH
// unless `withhold` is set. It records the size and command of every write and the packet it decoded from it. The codec
// decodes no shared filter, so the broker reads the Packet Identifier of a SUBSCRIBE or UNSUBSCRIBE from its bytes.
function broker(maximumPacketSize: number | undefined, withhold = false) {
  const writes: { bytes: number; cmd: string; messageId?: number; packet?: ClientPacket }[] = [];
  const transport: ByteTransport = {
    name: 'Limited broker',
    async open(inbound: Readonly<ByteInbound>) {
      const decoder = new PacketDecoder({ maxPacketBytes: 268_435_460 });
      return Promise.resolve({
        bufferedBytes: 0,
        async write(bytes: ReadonlyBytes) {
          const header = bytes[0];
          if (header === 0x82 || header === 0xa2) {
            let offset = 1;
            while (((bytes[offset] ?? 0) & 0x80) !== 0) offset++;
            const messageId = ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset + 2] ?? 0);
            const cmd = header === 0x82 ? 'subscribe' : 'unsubscribe';
            writes.push({ bytes: bytes.byteLength, cmd, messageId });
            if (!withhold) inbound.bytes(encodePacket({ cmd: header === 0x82 ? 'suback' : 'unsuback', messageId, granted: [0] }));
            return Promise.resolve();
          }
          for (const packet of decoder.push(bytes)) {
            if (packet.cmd === 'connack' || packet.cmd === 'suback' || packet.cmd === 'unsuback' || packet.cmd === 'pingresp')
              continue;
            writes.push({ bytes: bytes.byteLength, cmd: packet.cmd, packet });
            let reply: Parameters<typeof encodePacket>[0] | undefined;
            if (packet.cmd === 'connect')
              reply = {
                cmd: 'connack',
                sessionPresent: false,
                reasonCode: 0,
                ...(maximumPacketSize === undefined ? {} : { maximumPacketSize }),
              };
            if (packet.cmd === 'pingreq') reply = { cmd: 'pingresp' };
            if (!withhold && packet.cmd === 'publish' && packet.qos === 1)
              reply = { cmd: 'puback', messageId: packet.messageId, reasonCode: 0 };
            if (reply !== undefined) inbound.bytes(encodePacket(reply));
          }
          return Promise.resolve();
        },
        async close() {},
      });
    },
  };
  const connect = async (
    limits: Readonly<{
      maxPendingPublishes?: number;
      maxPendingPublishBytes?: number;
      maxPendingSubscriptions?: number;
      maxBufferedBytes?: number;
    }> = {},
  ) => createTransportClient(transport, { clientId: 'limited', onQosOneMessage() {}, ...limits }).connect();
  const commands = (): string[] => {
    const list: string[] = [];
    for (const { cmd } of writes) list.push(cmd);
    return list;
  };
  return { connect, writes, commands };
}

// The encoded size of a PUBLISH with a one-byte topic and a payload of `payloadBytes` bytes.
function publishSize(payloadBytes: number, qos: 0 | 1): number {
  const packet: ClientPacket =
    qos === 0
      ? { cmd: 'publish', topic: 't', payload: new Uint8Array(payloadBytes) }
      : { cmd: 'publish', topic: 't', payload: new Uint8Array(payloadBytes), qos: 1, messageId: 1 };
  return encodePacket(packet).byteLength;
}

const oversized = { code: 'ERR_MQTT_CAPACITY', fatal: false, message: 'MQTT packet exceeds the Maximum Packet Size' };

test.each([0, 1] as const)('sends a QoS %i PUBLISH of exactly the Maximum Packet Size and rejects one byte more', async (qos) => {
  const limit = 64;
  const payloadBytes = limit - publishSize(0, qos);
  expect(publishSize(payloadBytes, qos)).toBe(limit);
  const peer = broker(limit);
  const session = await peer.connect();
  expect(session.connection.maximumPacketSize).toBe(limit);
  await expect(session.publish('t', new Uint8Array(payloadBytes + 1), { qos })).rejects.toMatchObject(oversized);
  expect(peer.commands()).toEqual(['connect']);
  await session.publish('t', new Uint8Array(payloadBytes), { qos });
  expect(peer.writes.at(-1)).toMatchObject({ bytes: limit, packet: { cmd: 'publish', topic: 't' } });
  await session.disconnect();
});

test('a QoS 1 PUBLISH over the limit takes no Packet Identifier and no admission slot', async () => {
  const peer = broker(32);
  const session = await peer.connect({ maxPendingPublishes: 1 });
  await expect(session.publish('t', new Uint8Array(64), { qos: 1 })).rejects.toMatchObject(oversized);
  await session.publish('t', 'fits', { qos: 1 });
  expect(peer.writes.at(-1)?.packet).toMatchObject({ cmd: 'publish', messageId: 1 });
  await session.disconnect();
});

test('counts the PUBLISH properties against the limit', async () => {
  const peer = broker(64);
  const session = await peer.connect();
  const userProperties = [['key', 'v'.repeat(50)]] as const;
  await expect(session.publish('t', 'payload', { userProperties })).rejects.toMatchObject(oversized);
  await session.publish('t', 'payload', { userProperties: [['key', 'value']] });
  expect(peer.commands()).toEqual(['connect', 'publish']);
  await session.disconnect();
});

test.each(['subscribe', 'unsubscribe'] as const)('rejects a %s over the limit before writing it', async (command) => {
  const peer = broker(24);
  const session = await peer.connect();
  const filter = 'f'.repeat(24);
  const change = async (topic: string) => (command === 'subscribe' ? session.subscribe(topic) : session.unsubscribe(topic));
  await expect(change(filter)).rejects.toMatchObject(oversized);
  expect(peer.commands()).toEqual(['connect']);
  await change('f');
  await session.ping();
  expect(peer.commands()).toEqual(['connect', command, 'pingreq']);
  expect(peer.writes[1]?.messageId).toBe(1);
  await session.disconnect();
});

test('without a Maximum Packet Size the publication byte limit applies', async () => {
  const peer = broker(undefined);
  const session = await peer.connect({ maxPendingPublishBytes: 300_000 });
  expect(session.connection).not.toHaveProperty('maximumPacketSize');
  await session.publish('t', new Uint8Array(200_000));
  await expect(session.publish('t', new Uint8Array(300_000))).rejects.toMatchObject({
    code: 'ERR_MQTT_CAPACITY',
    fatal: false,
    message: 'MQTT publication capacity exceeded',
  });
  expect(peer.writes.at(-1)?.bytes).toBe(publishSize(200_000, 0));
  await session.disconnect();
});

const capacity = { code: 'ERR_MQTT_CAPACITY', fatal: false, message: 'MQTT publication capacity exceeded' };

test('a PUBLISH over the limit reports the limit even when every publication slot is taken', async () => {
  const peer = broker(64, true);
  const session = await peer.connect({ maxPendingPublishes: 1 });
  const held = session.publish('t', 'held', { qos: 1 }).catch((reason: unknown) => reason);
  await expect(session.publish('t', new Uint8Array(100))).rejects.toMatchObject(oversized);
  await expect(session.publish('t', 'fits')).rejects.toMatchObject(capacity);
  await session.disconnect({ drain: false });
  await held;
});

test.each(['a string', 'bytes'])('%s over both the limit and the publication byte limit reports the limit', async (kind) => {
  const peer = broker(64);
  const session = await peer.connect({ maxPendingPublishBytes: 100 });
  const payload = kind === 'bytes' ? new Uint8Array(200) : 'x'.repeat(200);
  await expect(session.publish('t', payload)).rejects.toMatchObject(oversized);
  expect(peer.commands()).toEqual(['connect']);
  await session.disconnect();
});

test('a string under the limit and over the publication byte limit reports capacity', async () => {
  const peer = broker(256);
  const session = await peer.connect({ maxPendingPublishBytes: 100 });
  await expect(session.publish('t', 'x'.repeat(120))).rejects.toMatchObject(capacity);
  await session.disconnect();
});

test.each([
  ['a two-byte character string', 'é'.repeat(60), 100, 'oversized'],
  ['a three-byte character string under the limit', '€'.repeat(60), 200, 'capacity'],
  ['a three-byte character string over the limit', '€'.repeat(60), 150, 'oversized'],
] as const)(
  '%s over the byte limit reports the limit only when its encoded PUBLISH exceeds it',
  async (_name, text, limit, outcome) => {
    const peer = broker(limit);
    const session = await peer.connect({ maxPendingPublishBytes: 50 });
    await expect(session.publish('t', text)).rejects.toMatchObject(outcome === 'oversized' ? oversized : capacity);
    expect(peer.commands()).toEqual(['connect']);
    await session.disconnect();
  },
);

test('a string longer than the limit and shorter than the byte limit rejects before it is encoded', async () => {
  const peer = broker(100);
  const session = await peer.connect();
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  await expect(session.publish('t', 'x'.repeat(500_000))).rejects.toMatchObject(oversized);
  expect(encode).not.toHaveBeenCalled();
  encode.mockRestore();
  expect(peer.commands()).toEqual(['connect']);
  await session.disconnect();
});

test('User Properties can push a string over the byte limit past the packet limit', async () => {
  const peer = broker(80);
  const session = await peer.connect({ maxPendingPublishBytes: 50 });
  await expect(session.publish('t', 'x'.repeat(60))).rejects.toMatchObject(capacity);
  await expect(session.publish('t', 'x'.repeat(60), { userProperties: [['key', 'v'.repeat(20)]] })).rejects.toMatchObject(
    oversized,
  );
  await session.disconnect();
});

test.each(['a string', 'bytes'])(
  '%s larger than the byte limit and under the packet limit gets the capacity message and never fits',
  async (kind) => {
    const peer = broker(1000);
    const session = await peer.connect({ maxPendingPublishBytes: 50 });
    const payload = kind === 'bytes' ? new Uint8Array(60) : 'a'.repeat(60);
    await expect(session.publish('t', payload)).rejects.toMatchObject(capacity);
    await expect(session.publish('t', payload)).rejects.toMatchObject(capacity);
    expect(peer.commands()).toEqual(['connect']);
    await session.disconnect();
  },
);

test('a SUBSCRIBE over the limit reports the limit even when every subscription slot is taken', async () => {
  const peer = broker(24, true);
  const session = await peer.connect({ maxPendingSubscriptions: 1 });
  const held = session.subscribe('a').catch((reason: unknown) => reason);
  await expect(session.subscribe('f'.repeat(24))).rejects.toMatchObject(oversized);
  await expect(session.subscribe('b')).rejects.toMatchObject({
    code: 'ERR_MQTT_CAPACITY',
    message: 'MQTT subscription capacity exceeded',
  });
  await session.disconnect({ drain: false });
  await held;
});

// The filters cover a shared filter, non-ASCII text and a Remaining Length of one, two and three bytes. A topic filter
// holds at most 65,535 bytes, so no SUBSCRIBE or UNSUBSCRIBE needs a four-byte Remaining Length.
const filters = [
  ['a shared filter', '$share/group/sensor/+'],
  ['non-ASCII text', 'é/😀/ü'],
  ['a two-byte Remaining Length', 'f'.repeat(200)],
  ['a three-byte Remaining Length', 'f'.repeat(20_000)],
] as const;

test.each(
  filters.flatMap(
    ([name, filter]) =>
      [
        ['subscribe', name, filter],
        ['unsubscribe', name, filter],
      ] as const,
  ),
)('sends a %s with %s at exactly the limit and rejects it one byte under', async (command, _name, filter) => {
  const packet: ClientPacket =
    command === 'subscribe'
      ? { cmd: 'subscribe', messageId: 1, topics: [filter], qos: 0 }
      : { cmd: 'unsubscribe', messageId: 1, topics: [filter] };
  const size = encodePacket(packet, { sharedSubscriptions: true }).byteLength;
  const tight = broker(size - 1);
  const rejected = await tight.connect();
  await expect(command === 'subscribe' ? rejected.subscribe(filter) : rejected.unsubscribe(filter)).rejects.toMatchObject(
    oversized,
  );
  expect(tight.commands()).toEqual(['connect']);
  await rejected.disconnect();
  const exact = broker(size);
  const accepted = await exact.connect();
  await (command === 'subscribe' ? accepted.subscribe(filter) : accepted.unsubscribe(filter));
  expect(exact.writes.at(-1)).toEqual({ bytes: size, cmd: command, messageId: 1 });
  await accepted.disconnect();
});

test('sends a PUBLISH with a four-byte Remaining Length at exactly the limit and rejects one byte more', async () => {
  const payloadBytes = 2_097_152;
  const limit = publishSize(payloadBytes, 0);
  expect(limit).toBe(1 + 4 + 2 + 1 + 1 + payloadBytes);
  const peer = broker(limit);
  const session = await peer.connect({ maxPendingPublishBytes: 4 * 1024 * 1024, maxBufferedBytes: 4 * 1024 * 1024 });
  await expect(session.publish('t', new Uint8Array(payloadBytes + 1))).rejects.toMatchObject(oversized);
  await session.publish('t', new Uint8Array(payloadBytes));
  expect(peer.writes.at(-1)?.bytes).toBe(limit);
  await session.disconnect();
});

test.each([1, 3])('ends the connection when CONNACK sets Maximum Packet Size %i, below the 4-byte PUBACK', async (limit) => {
  await expect(broker(limit).connect()).rejects.toMatchObject({
    code: 'ERR_MQTT_PROTOCOL',
    fatal: true,
    message: 'Unsupported broker Maximum Packet Size',
  });
});

test('accepts a Maximum Packet Size of 4', async () => {
  const peer = broker(4);
  const session = await peer.connect();
  await session.ping();
  await expect(session.publish('t', '')).rejects.toMatchObject(oversized);
  await session.disconnect();
});
