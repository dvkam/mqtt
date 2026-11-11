import { expect, test, vi } from 'vitest';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';
import { PacketDecoder } from '../src/codec.js';
import { createTcpClient, createWebSocketClient } from '../src/index.js';
import { createBrowserClient } from '../src/browser.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

type Kind = 'connack' | 'publish' | 'puback' | 'pubrec' | 'pubrel' | 'pubcomp' | 'suback' | 'unsuback' | 'disconnect';
function variable(value: number): number[] {
  const bytes: number[] = [];
  do {
    const digit = value % 128;
    value = Math.floor(value / 128);
    bytes.push(digit | (value > 0 ? 128 : 0));
  } while (value > 0);
  return bytes;
}
function scalar(identifier: number, width: number, value: number): number[] {
  return [
    identifier,
    ...(width === 0
      ? variable(value)
      : Array.from({ length: width }, (_value, index) => Math.floor(value / 256 ** (width - index - 1)) % 256)),
  ];
}
function stringField(identifier: number, bytes: readonly number[]): number[] {
  return [identifier, bytes.length >> 8, bytes.length & 255, ...bytes];
}
function frame(kind: Kind, properties: readonly number[]): number[] {
  const headers: Readonly<Record<Kind, number>> = {
    connack: 0x20,
    publish: 0x30,
    puback: 0x40,
    pubrec: 0x50,
    pubrel: 0x62,
    pubcomp: 0x70,
    suback: 0x90,
    unsuback: 0xb0,
    disconnect: 0xe0,
  };
  const prefix =
    kind === 'connack'
      ? [0, 0]
      : kind === 'publish'
        ? [0, 1, 0x61]
        : kind === 'disconnect'
          ? [0]
          : kind === 'suback' || kind === 'unsuback'
            ? [0, 1]
            : [0, 1, 0];
  const suffix = kind === 'suback' || kind === 'unsuback' ? [0] : [];
  const body = [...prefix, ...variable(properties.length), ...properties, ...suffix];
  return [headers[kind], ...variable(body.length), ...body];
}
function decode(bytes: readonly number[], split = bytes.length) {
  const packets: unknown[] = [];
  const decoder = new NodePacketDecoder({
    onPacket: (packet: unknown) => {
      packets.push(packet);
    },
  });
  const view = Uint8Array.from(bytes);
  let failure: unknown;
  try {
    decoder.push(view.subarray(0, split));
    decoder.push(view.subarray(split));
  } catch (reason) {
    failure = reason;
  }
  return { packets, failure };
}

const connackSingletons = [
  [0x11, 0, 0, 0, 0],
  [0x12, 0, 1, 0x78],
  [0x13, 0, 0],
  [0x15, 0, 1, 0x61],
  [0x16, 0, 0],
  [0x1a, 0, 0],
  [0x1c, 0, 0],
  [0x1f, 0, 0],
  [0x21, 0, 1],
  [0x22, 0, 0],
  [0x24, 0],
  [0x25, 0],
  [0x27, 0, 0, 0, 1],
  [0x28, 0],
  [0x29, 0],
  [0x2a, 0],
] as const;
const publishSingletons = [
  [0x01, 0],
  [0x02, 0, 0, 0, 0],
  [0x03, 0, 0],
  [0x08, 0, 1, 0x72],
  [0x09, 0, 0],
  [0x23, 0, 1],
] as const;
const singletonCases = [
  ...connackSingletons.map((property) => ({ kind: 'connack' as const, property })),
  ...publishSingletons.map((property) => ({ kind: 'publish' as const, property })),
  ...(['puback', 'pubrec', 'pubrel', 'pubcomp', 'suback', 'unsuback'] as const).map((kind) => ({ kind, property: [0x1f, 0, 0] })),
  ...[
    [0x1c, 0, 0],
    [0x1f, 0, 0],
  ].map((property: readonly number[]) => ({ kind: 'disconnect' as const, property })),
];

test.each(singletonCases)(
  '$kind rejects a repeated singleton $property before native projection',
  ({ kind, property }: Readonly<{ kind: Kind; property: readonly number[] }>) => {
    const bytes = frame(kind, [...property, ...property]);
    for (let split = 0; split <= bytes.length; split++) {
      const result = decode(bytes, split);
      expect(result.failure).toBeInstanceOf(Error);
      expect(result.packets).toEqual([]);
    }
  },
);

const flags = [
  { kind: 'connack', identifier: 0x24, name: 'maximumQoS', numeric: true },
  { kind: 'connack', identifier: 0x25, name: 'retainAvailable', numeric: false },
  { kind: 'connack', identifier: 0x28, name: 'wildcardSubscriptionAvailable', numeric: false },
  { kind: 'connack', identifier: 0x29, name: 'subscriptionIdentifiersAvailable', numeric: false },
  { kind: 'connack', identifier: 0x2a, name: 'sharedSubscriptionAvailable', numeric: false },
  { kind: 'publish', identifier: 0x01, name: 'payloadFormatIndicator', numeric: false },
] as const;

test.each(flags.flatMap((item) => [2, 255].map((value) => ({ ...item, value }))))(
  '$kind rejects invalid $name value $value',
  ({ kind, identifier, value }: Readonly<{ kind: Kind; identifier: number; value: number }>) => {
    const result = decode(frame(kind, [identifier, value]));
    expect(result.failure).toBeInstanceOf(Error);
    expect(result.packets).toEqual([]);
  },
);
test.each(flags.flatMap((item) => [0, 1].map((value) => ({ ...item, value }))))(
  '$kind preserves valid $name value $value',
  ({
    kind,
    identifier,
    name,
    numeric,
    value,
  }: Readonly<{ kind: Kind; identifier: number; name: string; numeric: boolean; value: number }>) => {
    const result = decode(frame(kind, [identifier, value]));
    expect(result.failure).toBeUndefined();
    expect(result.packets).toHaveLength(1);
    expect(result.packets[0]).toMatchObject({ properties: { [name]: numeric ? value : value === 1 } });
  },
);

const nonzero = [
  { kind: 'connack', identifier: 0x21, width: 2, name: 'receiveMaximum', maximum: 65_535 },
  { kind: 'connack', identifier: 0x27, width: 4, name: 'maximumPacketSize', maximum: 4_294_967_295 },
  { kind: 'publish', identifier: 0x0b, width: 0, name: 'subscriptionIdentifier', maximum: 268_435_455 },
] as const;
test.each(nonzero)('$kind rejects zero $name', ({ kind, identifier, width }) => {
  const result = decode(frame(kind, scalar(identifier, width, 0)));
  expect(result.failure).toBeInstanceOf(Error);
  expect(result.packets).toEqual([]);
});
test.each(nonzero.flatMap((item) => [1, item.maximum].map((value) => ({ ...item, value }))))(
  '$kind preserves $name boundary $value',
  ({
    kind,
    identifier,
    width,
    name,
    value,
  }: Readonly<{ kind: Kind; identifier: number; width: number; name: string; value: number }>) => {
    const result = decode(frame(kind, scalar(identifier, width, value)));
    expect(result.failure).toBeUndefined();
    expect(result.packets[0]).toMatchObject({ properties: { [name]: value } });
  },
);

test.each([
  { kind: 'connack', identifier: 0x11, width: 4, name: 'sessionExpiryInterval' },
  { kind: 'connack', identifier: 0x13, width: 2, name: 'serverKeepAlive' },
  { kind: 'connack', identifier: 0x22, width: 2, name: 'topicAliasMaximum' },
  { kind: 'publish', identifier: 0x02, width: 4, name: 'messageExpiryInterval' },
] as const)('$kind permits zero $name', ({ kind, identifier, width, name }) => {
  const result = decode(frame(kind, scalar(identifier, width, 0)));
  expect(result.failure).toBeUndefined();
  expect(result.packets[0]).toMatchObject({ properties: { [name]: 0 } });
});

test.each([[], [0x2b], [0x23], [0x61, 0x2f, 0x2b], [0x61, 0x2f, 0x23]])(
  'rejects invalid Response Topic %j',
  (...bytes: readonly number[]) => {
    const result = decode(frame('publish', stringField(0x08, bytes)));
    expect(result.failure).toMatchObject({ code: 0x82 });
    expect(result.packets).toEqual([]);
  },
);
test.each([[0x2f], [0xef, 0xbb, 0xbf, 0xc3, 0xa9]])('preserves a valid Response Topic %j', (...bytes: readonly number[]) => {
  const result = decode(frame('publish', stringField(0x08, bytes)));
  expect(result.failure).toBeUndefined();
  expect(result.packets[0]).toMatchObject({
    properties: { responseTopic: new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(bytes)) },
  });
});

test('preserves the zero-alias 0x94 and duplicate-alias 0x82 classifications', () => {
  expect(decode(frame('publish', [0x23, 0, 0])).failure).toMatchObject({ code: 0x94 });
  expect(decode(frame('publish', [0x23, 0, 1, 0x23, 0, 1])).failure).toMatchObject({ code: 0x82 });
});
test.each([1, 65_535])('keeps a positive raw alias %i syntactically valid', (value) => {
  const result = decode(frame('publish', scalar(0x23, 2, value)));
  expect(result.failure).toBeUndefined();
  expect(result.packets[0]).toMatchObject({ properties: { topicAlias: value } });
});
test('allows repeated equal Subscription Identifiers and ordered User Properties', () => {
  const pairs = [0x26, 0, 1, 0x6b, 0, 1, 0x76, 0x26, 0, 1, 0x6b, 0, 1, 0x77];
  const result = decode(frame('publish', [0x0b, 1, ...pairs, 0x0b, 1]));
  expect(result.failure).toBeUndefined();
  expect(result.packets[0]).toMatchObject({ properties: { subscriptionIdentifier: [1, 1], userProperties: { k: ['v', 'w'] } } });
});

test.each([
  { kind: 'connack', property: [0x21, 0, 1] },
  { kind: 'connack', property: [0x22, 0, 0] },
  { kind: 'connack', property: [0x24, 0] },
  { kind: 'puback', property: [0x1f, 0, 0] },
  { kind: 'suback', property: [0x1f, 0, 0] },
  { kind: 'unsuback', property: [0x1f, 0, 0] },
] as const)('portable $kind continues to reject a repeated supported singleton', ({ kind, property }) => {
  expect(() => new PacketDecoder().push(Uint8Array.from(frame(kind, [...property, ...property])))).toThrow(/Invalid .* property/);
});

test.each(['tcp', 'node-websocket'] as const)('%s rejects an invalid flag before connection acceptance', async (adapter) => {
  const reply = frame('connack', [0x25, 2]);
  const peer =
    adapter === 'tcp' ? await startTcpPacketPeer('fixed-connect', reply) : await startWebSocketPacketPeer('fixed-connect', reply);
  try {
    const options = { clientId: 'invalid-capability', timeoutMs: 1000 };
    const factory = 'host' in peer ? createTcpClient({ ...peer, ...options }) : createWebSocketClient({ ...peer, ...options });
    const failure = await factory.connect().catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(Error);
    await expect(factory.connect()).rejects.toBe(failure);
    await expect.poll(peer.connections).toBe(0);
  } finally {
    await peer.close();
  }
});

test.each(['tcp', 'node-websocket', 'browser'] as const)(
  '%s cannot complete a publish from a duplicate Reason String',
  async (adapter) => {
    const properties = [0x1f, 0, 1, 0x78, 0x1f, 0, 1, 0x79];
    const reply = [0x30, 4, 0, 1, 0x62, 0, ...frame('puback', properties), 0x30, 4, 0, 1, 0x7a, 0];
    const peer =
      adapter === 'tcp' ? await startTcpPacketPeer('fixed-publish', reply) : await startWebSocketPacketPeer('fixed-publish', reply);
    const onMessage = vi.fn<(packet: unknown) => void>();
    const options = { clientId: 'duplicate-ack', timeoutMs: 1000, onMessage };
    try {
      const factory =
        'host' in peer
          ? createTcpClient({ ...peer, ...options })
          : adapter === 'browser'
            ? createBrowserClient({ ...peer, ...options })
            : createWebSocketClient({ ...peer, ...options });
      const client = await factory.connect();
      const failure = await client.publish('metadata', 'data', { qos: 1 }).catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(Error);
      expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topic: 'b' }));
      await expect(client.ping()).rejects.toBe(failure);
      await expect.poll(peer.connections).toBe(0);
    } finally {
      await peer.close();
    }
  },
);

test('resets singleton tracking for each packet and leaves non-topic strings unrestricted', () => {
  const properties = [...stringField(0x03, [0x2b, 0x23]), 0x26, 0, 1, 0x2b, 0, 1, 0x23];
  const bytes = frame('publish', properties);
  const result = decode([...bytes, ...bytes]);
  expect(result.failure).toBeUndefined();
  expect(result.packets).toHaveLength(2);
  expect(result.packets[0]).toMatchObject({ properties: { contentType: '+#', userProperties: { '+': '#' } } });
  expect(result.packets[1]).toMatchObject({ properties: { contentType: '+#', userProperties: { '+': '#' } } });
});

test('does not introduce payload UTF-8 validation for Payload Format Indicator 1', () => {
  const bytes = frame('publish', [0x01, 1]);
  bytes[1] = bytes[1]! + 1;
  bytes.push(0xc0);
  const result = decode(bytes);
  expect(result.failure).toBeUndefined();
  expect(result.packets[0]).toMatchObject({ properties: { payloadFormatIndicator: true }, payload: Buffer.of(0xc0) });
});

test.each([
  { kind: 'connack', properties: [0x21, 0, 0] },
  { kind: 'connack', properties: [0x24, 2] },
] as const)('portable $kind retains scalar validation for $properties', ({ kind, properties }) => {
  expect(() => new PacketDecoder().push(Uint8Array.from(frame(kind, properties)))).toThrow('MQTT integer out of range');
});

test.each(['tcp', 'node-websocket'] as const)(
  '%s classifies an invalid Response Topic before application delivery',
  async (adapter) => {
    const reply = [0x30, 4, 0, 1, 0x62, 0, ...frame('publish', [0x08, 0, 1, 0x2b]), 0x30, 4, 0, 1, 0x7a, 0];
    const peer =
      adapter === 'tcp' ? await startTcpPacketPeer('fixed-reply', reply) : await startWebSocketPacketPeer('fixed-reply', reply);
    const onMessage = vi.fn<(packet: unknown) => void>();
    const options = { clientId: 'invalid-response-topic', timeoutMs: 1000, onMessage };
    try {
      const client = await (
        'host' in peer ? createTcpClient({ ...peer, ...options }) : createWebSocketClient({ ...peer, ...options })
      ).connect();
      const failure = await client.ping().catch((reason: unknown) => reason);
      expect(failure).toMatchObject({ code: 0x82 });
      expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topic: 'b' }));
      await expect(client.ping()).rejects.toBe(failure);
      await expect.poll(() => peer.disconnectReasons).toEqual([0x82]);
    } finally {
      await peer.close();
    }
  },
);
