import { expect, test } from 'vitest';
import type { ByteInbound, ByteTransport } from '../src/byteTransport.js';
import { encodePacket, PacketDecoder, type ClientPacket } from '../src/codec.js';
import { createTransportClient } from '../src/portableClient.js';

// A broker that sends `maximumPacketSize` in CONNACK and answers SUBSCRIBE, UNSUBSCRIBE, PINGREQ and QoS 1 PUBLISH. It
// records the size of every write and the packet it decoded from it.
function broker(maximumPacketSize: number | undefined) {
  const writes: { bytes: number; packet: ClientPacket }[] = [];
  const transport: ByteTransport = {
    name: 'Limited broker',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- ByteTransport.open in src/byteTransport.ts takes the mutable ByteInbound and returns a promise, and promise-function-async requires an async function for that. This opener settles without waiting for anything.
    async open(inbound: ByteInbound) {
      const decoder = new PacketDecoder();
      return {
        bufferedBytes: 0,
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- ByteWriter.write in src/byteTransport.ts takes the encoded Uint8Array by identity and returns a promise. This writer replies synchronously.
        async write(bytes: Uint8Array) {
          for (const packet of decoder.push(bytes)) {
            if (packet.cmd === 'connack' || packet.cmd === 'suback' || packet.cmd === 'unsuback' || packet.cmd === 'pingresp')
              continue;
            writes.push({ bytes: bytes.byteLength, packet });
            let reply: Parameters<typeof encodePacket>[0] | undefined;
            if (packet.cmd === 'connect')
              reply = {
                cmd: 'connack',
                sessionPresent: false,
                reasonCode: 0,
                ...(maximumPacketSize === undefined ? {} : { maximumPacketSize }),
              };
            if (packet.cmd === 'subscribe') reply = { cmd: 'suback', messageId: packet.messageId, granted: [0] };
            if (packet.cmd === 'unsubscribe') reply = { cmd: 'unsuback', messageId: packet.messageId, granted: [0] };
            if (packet.cmd === 'pingreq') reply = { cmd: 'pingresp' };
            if (packet.cmd === 'publish' && packet.qos === 1) reply = { cmd: 'puback', messageId: packet.messageId, reasonCode: 0 };
            if (reply !== undefined) inbound.bytes(encodePacket(reply));
          }
        },
        async close() {},
      };
    },
  };
  const connect = async (limits: Readonly<{ maxPendingPublishes?: number; maxPendingPublishBytes?: number }> = {}) =>
    createTransportClient(transport, { clientId: 'limited', onQosOneMessage() {}, ...limits }).connect();
  const commands = (): string[] => {
    const list: string[] = [];
    for (const { packet } of writes) list.push(packet.cmd);
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
  expect(peer.writes[1]?.packet).toMatchObject({ messageId: 1 });
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
