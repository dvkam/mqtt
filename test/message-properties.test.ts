import { expect, test, vi } from 'vitest';
import { createBrowserClient } from '../src/browser.js';
import { createTcpClient, createWebSocketClient } from '../src/index.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

const adapters = ['tcp', 'node-websocket', 'browser'] as const;
type Adapter = (typeof adapters)[number];

const properties = [
  ...[0x01, 1],
  ...[0x02, 0, 0, 0, 30],
  ...[0x03, 0, 1, 0x63],
  ...[0x08, 0, 1, 0x72],
  ...[0x09, 0, 2, 7, 8],
  ...[0x0b, 1, 0x0b, 0xc8, 0x01],
  ...[0x26, 0, 1, 0x62, 0, 1, 0x31],
  ...[0x26, 0, 1, 0x61, 0, 1, 0x32],
  ...[0x26, 0, 1, 0x62, 0, 1, 0x33],
];

function publication(qos: number, fields: readonly number[]): number[] {
  const body = [0, 1, 0x74, ...(qos === 0 ? [] : [0, 17]), fields.length, ...fields, 0xff, 0];
  return [0x31 | (qos << 1), body.length, ...body];
}

async function receive(adapter: Adapter, qos: number, fields: readonly number[]) {
  const response = [...publication(qos, fields), 0xd0, 0];
  const peer =
    adapter === 'tcp' ? await startTcpPacketPeer('fixed-reply', response) : await startWebSocketPacketPeer('fixed-reply', response);
  const onMessage = vi.fn<(packet: unknown) => void>();
  const onQosOneMessage = vi.fn<(packet: unknown) => void>();
  const options = { clientId: 'message-properties', timeoutMs: 1000, onMessage, onQosOneMessage };
  try {
    const factory =
      'host' in peer
        ? createTcpClient({ ...peer, ...options })
        : adapter === 'browser'
          ? createBrowserClient({ ...peer, ...options })
          : createWebSocketClient({ ...peer, ...options });
    const client = await factory.connect();
    await client.ping();
    const received = qos === 0 ? onMessage : onQosOneMessage;
    expect(received).toHaveBeenCalledTimes(1);
    const message = received.mock.calls[0]?.[0];
    await client.disconnect();
    if (typeof message !== 'object' || message === null) throw new Error('Expected a message');
    return message;
  } finally {
    await peer.close();
  }
}

function plainBytes(value: unknown): unknown {
  return value instanceof Uint8Array ? [...value] : value;
}

test.each(adapters.flatMap((adapter) => [0, 1].map((qos) => ({ adapter, qos }))))(
  '$adapter delivers every PUBLISH property flat at QoS $qos',
  async ({ adapter, qos }: Readonly<{ adapter: Adapter; qos: number }>) => {
    const message = await receive(adapter, qos, properties);
    const plain = Object.fromEntries(
      Object.entries(message).map((entry: Readonly<[string, unknown]>) => [entry[0], plainBytes(entry[1])]),
    );
    expect(plain).toStrictEqual({
      cmd: 'publish',
      topic: 't',
      payload: [0xff, 0],
      qos,
      dup: false,
      retain: true,
      ...(qos === 1 ? { messageId: 17 } : {}),
      payloadFormatIndicator: 1,
      messageExpiryInterval: 30,
      contentType: 'c',
      responseTopic: 'r',
      correlationData: [7, 8],
      subscriptionIdentifiers: [1, 200],
      userProperties: [
        ['b', '1'],
        ['a', '2'],
        ['b', '3'],
      ],
    });
  },
);

test.each(adapters)('%s leaves out the keys of properties the broker did not send', async (adapter) => {
  const message = await receive(adapter, 0, []);
  expect(new Set(Object.keys(message))).toEqual(new Set(['cmd', 'topic', 'payload', 'qos', 'dup', 'retain']));
});

test.each(['tcp', 'node-websocket'] as const)('%s delivers payload and Correlation Data as Buffers', async (adapter) => {
  const message = await receive(adapter, 0, properties);
  expect(message).toMatchObject({ payload: Buffer.from([0xff, 0]), correlationData: Buffer.from([7, 8]) });
  if (!('payload' in message) || !('correlationData' in message)) throw new Error('Expected byte fields');
  expect(Buffer.isBuffer(message.payload)).toBe(true);
  expect(Buffer.isBuffer(message.correlationData)).toBe(true);
});
