import { expect, test } from 'vitest';
import { encodePacket, PacketDecoder, type ClientPacket } from '../src/codec.js';
import { connectPortable, type PacketTransport } from '../src/portable.js';
import { capturePublication, type PublishProperties } from '../src/publication.js';
import type { ReadonlyDeep } from '../src/util/bytes.js';

// Accepts CONNECT and answers every QoS 1 PUBLISH with a successful PUBACK. Records the packets the session sends.
async function connected(limits: Readonly<{ maxPendingPublishBytes?: number }> = {}, retainAvailable = true) {
  let deliver: Parameters<PacketTransport['listen']>[0] | undefined;
  const sent: ReadonlyDeep<ClientPacket>[] = [];
  const transport: PacketTransport = {
    async send(packet: ReadonlyDeep<ClientPacket>) {
      sent.push(packet);
      if (packet.cmd === 'connect') deliver?.({ cmd: 'connack', sessionPresent: false, reasonCode: 0, retainAvailable });
      if (packet.cmd === 'publish' && packet.qos === 1) deliver?.({ cmd: 'puback', messageId: packet.messageId, reasonCode: 0 });
      return Promise.resolve();
    },
    listen(onPacket) {
      deliver = onPacket;
      return () => {};
    },
    async close() {},
  };
  const session = await connectPortable(transport, { clientId: 'publish-options', ...limits });
  return {
    session,
    count: () => sent.length,
    lastPublish: () => {
      for (let index = sent.length - 1; index >= 0; index--) {
        const packet = sent[index];
        if (packet?.cmd === 'publish') return packet;
      }
      throw new Error('Expected a PUBLISH');
    },
  };
}

const properties = {
  retain: true,
  payloadFormatIndicator: 0,
  messageExpiryInterval: 60,
  contentType: 'application/octet-stream',
  responseTopic: 'reply/7',
  correlationData: Uint8Array.of(0xc0, 0xff, 0xee),
  userProperties: [
    ['k', '1'],
    ['k', '2'],
  ],
} as const;

test('publishes a byte payload unchanged', async () => {
  const { session, lastPublish } = await connected();
  const payload = Uint8Array.of(0, 1, 0xfe, 0xff);
  await session.publish('bytes', payload);
  expect(lastPublish()).toEqual({ cmd: 'publish', topic: 'bytes', payload, retain: false });
});

test.each([0, 1] as const)('sends retain and every MQTT 5 PUBLISH property at QoS %i', async (qos) => {
  const { session, lastPublish } = await connected();
  await session.publish('props', 'hello', { qos, ...properties });
  expect(lastPublish()).toMatchObject({
    topic: 'props',
    payload: new TextEncoder().encode('hello'),
    ...properties,
    ...(qos === 1 ? { qos: 1, dup: false } : {}),
  });
});

test('encodes and decodes each PUBLISH property, a byte payload and retain on the wire', () => {
  const packet: ClientPacket = { cmd: 'publish', topic: 't', payload: Uint8Array.of(0, 255), ...properties };
  // The encoder writes User Properties first, then the other properties in identifier order.
  const propertyBytes = [
    0x26,
    0,
    1,
    0x6b,
    0,
    1,
    0x31,
    0x26,
    0,
    1,
    0x6b,
    0,
    1,
    0x32,
    0x01,
    0,
    0x02,
    0,
    0,
    0,
    60,
    0x03,
    0,
    24,
    ...new TextEncoder().encode('application/octet-stream'),
    0x08,
    0,
    7,
    ...new TextEncoder().encode('reply/7'),
    0x09,
    0,
    3,
    0xc0,
    0xff,
    0xee,
  ];
  const bytes = encodePacket(packet);
  expect([...bytes]).toEqual([0x31, 3 + 1 + propertyBytes.length + 2, 0, 1, 0x74, propertyBytes.length, ...propertyBytes, 0, 255]);
  const [decoded] = new PacketDecoder().push(bytes);
  expect(decoded).toMatchObject({ cmd: 'publish', topic: 't', payload: Uint8Array.of(0, 255), ...properties });
});

test.each([
  ['a lone high surrogate', 'a\uD800b'],
  ['a lone low surrogate', '\uDC00'],
])('rejects a text payload with %s before any write', async (_name, payload) => {
  const { session, count } = await connected();
  const before = count();
  await expect(session.publish('t', payload)).rejects.toMatchObject({ code: 'ERR_MQTT_INVALID_ARGUMENT', fatal: false });
  expect(count()).toBe(before);
  await session.publish('t', 'still active');
});

test.each([
  ['an unsupported Payload Format Indicator', (): Record<string, unknown> => ({ payloadFormatIndicator: 2 })],
  ['a Message Expiry Interval above 32 bits', (): Record<string, unknown> => ({ messageExpiryInterval: 2 ** 32 })],
  ['a fractional Message Expiry Interval', (): Record<string, unknown> => ({ messageExpiryInterval: 1.5 })],
  ['a Content Type with U+0000', (): Record<string, unknown> => ({ contentType: 'a\u0000b' })],
  ['a wildcard Response Topic', (): Record<string, unknown> => ({ responseTopic: 'reply/#' })],
  ['an empty Response Topic', (): Record<string, unknown> => ({ responseTopic: '' })],
  ['Correlation Data that is not bytes', (): Record<string, unknown> => ({ correlationData: 'abc' })],
  ['Correlation Data over 65,535 bytes', (): Record<string, unknown> => ({ correlationData: new Uint8Array(65_536) })],
  ['a User Property that is not a pair', (): Record<string, unknown> => ({ userProperties: [['k']] })],
  ['a User Property with an unpaired surrogate', (): Record<string, unknown> => ({ userProperties: [['k', '\uD800']] })],
  ['a retain flag that is not a boolean', (): Record<string, unknown> => ({ retain: 'yes' })],
  ['a signal that is not an AbortSignal at QoS 0', (): Record<string, unknown> => ({ signal: {} })],
  ['a signal that is not an AbortSignal at QoS 1', (): Record<string, unknown> => ({ qos: 1, signal: {} })],
  [
    'a byte payload marked as UTF-8 that is not UTF-8',
    (): Record<string, unknown> => ({ payloadFormatIndicator: 1, payload: Uint8Array.of(0xff) }),
  ],
])('rejects %s before any write and keeps the session usable', async (_name, make) => {
  const { session, count } = await connected();
  const before = count();
  const { payload = 'x', ...options } = make();
  const failure: unknown = await session
    // The test passes untyped values, as a JavaScript caller could.
    .publish('t', payload instanceof Uint8Array ? payload : 'x', options)
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: 'ERR_MQTT_INVALID_ARGUMENT', fatal: false });
  expect(count()).toBe(before);
  await session.publish('t', 'still active');
});

test('rejects retain when the broker does not support retained messages', async () => {
  const { session, count } = await connected({}, false);
  const before = count();
  await expect(session.publish('t', 'x', { retain: true })).rejects.toMatchObject({
    code: 'ERR_MQTT_INVALID_ARGUMENT',
    message: 'Broker does not support retained messages',
  });
  expect(count()).toBe(before);
  await session.publish('t', 'x', { retain: false });
});

test('counts property bytes against the publication byte limit', async () => {
  const correlationData = new Uint8Array(100);
  // PUBLISH 'a': fixed header 2 bytes, topic 3, property length 1, Correlation Data 3 + 100, payload 1.
  const exact = 2 + 3 + 1 + 103 + 1;
  const fits = await connected({ maxPendingPublishBytes: exact });
  await fits.session.publish('a', 'x', { correlationData });
  const tight = await connected({ maxPendingPublishBytes: exact - 1 });
  await expect(tight.session.publish('a', 'x', { correlationData })).rejects.toMatchObject({ code: 'ERR_MQTT_CAPACITY' });
});

test('a QoS 0 publish honors a signal that is already aborted and ignores a later abort', async () => {
  const { session, count } = await connected();
  const reason = new Error('caller gave up');
  const aborted = new AbortController();
  aborted.abort(reason);
  const before = count();
  await expect(session.publish('t', 'x', { signal: aborted.signal })).rejects.toBe(reason);
  expect(count()).toBe(before);
  const live = new AbortController();
  await session.publish('t', 'x', { signal: live.signal });
  live.abort();
  expect(count()).toBe(before + 1);
});

test('republishes a received message with its properties', async () => {
  const { session, lastPublish } = await connected();
  const received = {
    cmd: 'publish',
    topic: 'in',
    payload: Uint8Array.of(1, 2),
    qos: 0,
    dup: false,
    retain: false,
    contentType: 'c',
    subscriptionIdentifiers: [3],
  } as const;
  await session.publish('out', received.payload, received);
  expect(lastPublish()).toEqual({
    cmd: 'publish',
    topic: 'out',
    payload: Uint8Array.of(1, 2),
    retain: false,
    contentType: 'c',
  });
});

test.each([
  ['no property', (): PublishProperties => ({})],
  ['every property', (): PublishProperties => properties],
  [
    'non-ASCII strings',
    (): PublishProperties => ({ contentType: 'tëxt/π', responseTopic: 'réply/😀', userProperties: [['ключ', '値']] }),
  ],
  [
    'a property section over 127 bytes',
    (): PublishProperties => ({ correlationData: new Uint8Array(200), userProperties: [['k', 'v'.repeat(20_000)]] }),
  ],
])('admission sizes the property section the encoder writes, with %s', (_name, make) => {
  const options = make();
  const topic = 'sized';
  const payload = Uint8Array.of(1, 2, 3);
  const publication = capturePublication(topic, payload, options, true, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0);
  const { retain: _retain, ...propertyFields } = options;
  const frame = encodePacket({ cmd: 'publish', topic, payload, ...propertyFields });
  let remaining = 0;
  let headerBytes = 1;
  for (let shift = 0; ; shift += 7) {
    const digit = frame[headerBytes++] ?? 0;
    remaining += (digit & 127) * 2 ** shift;
    if (digit < 128) break;
  }
  expect(headerBytes + remaining).toBe(frame.length);
  expect(publication.propertyBytes).toBe(remaining - (2 + topic.length) - payload.length);
});
