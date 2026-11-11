import { getEventListeners } from 'node:events';
import { expect, test, vi } from 'vitest';
import { connectPortable, type PacketTransport } from '../src/portable.js';
import { createTcpClient, createWebSocketClient } from '../src/index.js';
import { createBrowserClient } from '../src/browser.js';
import { PacketDecoder, encodePacket } from '../src/codec.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

function decodedPeer(onListen?: () => void) {
  let receive: Parameters<PacketTransport['listen']>[0] | undefined;
  let closed: Parameters<PacketTransport['listen']>[1] | undefined;
  const close = vi.fn<(force?: boolean) => Promise<void>>(async () => {
    await Promise.resolve();
  });
  const sent: string[] = [];
  const clientIds: string[] = [];
  const transport: PacketTransport = {
    async send(packet: Readonly<{ cmd: string; clientId?: string }>) {
      sent.push(packet.cmd);
      if (packet.clientId !== undefined) clientIds.push(packet.clientId);
      await Promise.resolve();
    },
    listen(onPacket, onClose) {
      receive = onPacket;
      closed = onClose;
      onListen?.();
      return () => {};
    },
    close,
  };
  return { transport, close, sent, clientIds, receive: () => receive, closed: () => closed };
}

test.each(['empty-method', 'method', 'empty-data', 'data', 'both'])(
  'rejects unsolicited decoded authentication %s before activation',
  async (kind) => {
    const properties =
      kind === 'empty-method'
        ? { authenticationMethod: '' }
        : kind === 'method'
          ? { authenticationMethod: 'SCRAM-SHA-256' }
          : kind === 'empty-data'
            ? { authenticationData: Buffer.alloc(0) }
            : kind === 'data'
              ? { authenticationData: Buffer.from([0xc0, 0]) }
              : { authenticationMethod: 'x', authenticationData: Buffer.from([1]) };
    const peer = decodedPeer();
    const onMessage = vi.fn<() => void>();
    const opening = connectPortable(peer.transport, { clientId: 'named', onMessage }).catch((reason: unknown) => reason);
    peer.receive()?.({ cmd: 'connack', reasonCode: 0, sessionPresent: false, properties });
    peer.receive()?.({ cmd: 'publish', qos: 0, topic: 'a', payload: Buffer.from('suffix'), dup: false, retain: false });
    const failure = await opening;
    expect(failure).toMatchObject({ message: 'Unexpected MQTT authentication properties', code: 0x82 });
    expect(onMessage).not.toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
  },
);

test.each([
  { clientId: '', properties: undefined },
  { clientId: '', properties: { assignedClientIdentifier: '' } },
  { clientId: 'named', properties: { assignedClientIdentifier: 'changed' } },
  { clientId: 'named', properties: { assignedClientIdentifier: '' } },
  { clientId: '', properties: { assignedClientIdentifier: 'bad\u0000id' } },
  { clientId: '', properties: { assignedClientIdentifier: '\ud800' } },
  { clientId: '', properties: { assignedClientIdentifier: 'a'.repeat(65_536) } },
  { clientId: '', properties: { assignedClientIdentifier: 'é'.repeat(32_768) } },
])(
  'rejects inconsistent decoded assignment %j',
  async ({
    clientId,
    properties,
  }: Readonly<{ clientId: string; properties: Readonly<{ assignedClientIdentifier: string }> | undefined }>) => {
    const peer = decodedPeer();
    const opening = connectPortable(peer.transport, { clientId }).catch((reason: unknown) => reason);
    peer.receive()?.({ cmd: 'connack', reasonCode: 0, sessionPresent: false, properties });
    expect(await opening).toMatchObject({ message: 'Invalid MQTT Assigned Client Identifier', code: 0x82 });
    expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
  },
);

test.each([
  { clientId: '', assigned: 'server-id' },
  { clientId: 'named', assigned: 'named' },
  { clientId: '', assigned: '\ufeff😀' },
])(
  'accepts consistent assignment %j without retaining mutable reply fields',
  async ({ clientId, assigned }: Readonly<{ clientId: string; assigned: string }>) => {
    const peer = decodedPeer();
    const opening = connectPortable(peer.transport, { clientId });
    const properties = { assignedClientIdentifier: assigned };
    peer.receive()?.({ cmd: 'connack', reasonCode: 0, sessionPresent: false, properties });
    properties.assignedClientIdentifier = '';
    const client = await opening;
    await client.disconnect();
    expect(peer.sent).toEqual(['connect', 'disconnect']);
  },
);

test('AUTH before CONNACK owns failure before a later refusal and close', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: 'named' }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'auth', reasonCode: 0x18 });
  peer.receive()?.({ cmd: 'connack', reasonCode: 0x87, sessionPresent: false });
  peer.closed()?.(new Error('later close'));
  expect(await opening).toMatchObject({ message: 'Unexpected MQTT AUTH', code: 0x82 });
  expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
});

test('active AUTH retires a pending ping and blocks the suffix with one error', async () => {
  const peer = decodedPeer();
  const onMessage = vi.fn<() => void>();
  const opening = connectPortable(peer.transport, { clientId: 'named', onMessage });
  peer.receive()?.({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
  const client = await opening;
  const pending = client.ping().catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'auth', reasonCode: 0 });
  peer.receive()?.({ cmd: 'pingresp' });
  peer.receive()?.({ cmd: 'publish', qos: 0, topic: 'a', payload: Buffer.alloc(0), dup: false, retain: false });
  const failure = await pending;
  expect(failure).toMatchObject({ message: 'Unexpected MQTT AUTH', code: 0x82 });
  await expect(client.ping()).rejects.toBe(failure);
  expect(onMessage).not.toHaveBeenCalled();
  expect(peer.sent).toEqual(['connect', 'pingreq', 'disconnect']);
});

test('an empty requested ID preserves a refusal instead of requiring assignment', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: '' }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'connack', reasonCode: 0x85, sessionPresent: false });
  expect(await opening).toMatchObject({ message: 'MQTT acknowledgment refused', code: 0x85 });
});

function assignment(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [0x12, bytes.length >> 8, bytes.length & 255, ...bytes];
}

test('uses one client ID snapshot for CONNECT and agreement despite mutable options', async () => {
  const options = { clientId: 'original' };
  const peer = decodedPeer(() => {
    options.clientId = 'during-listen';
  });
  const opening = connectPortable(peer.transport, options);
  options.clientId = 'after-send';
  peer.receive()?.({ cmd: 'connack', reasonCode: 0, sessionPresent: false, properties: { assignedClientIdentifier: 'original' } });
  const client = await opening;
  expect(peer.clientIds).toEqual(['original']);
  await client.disconnect();
});

test('coalesced success and QoS 1 followed by AUTH cannot activate or deliver', async () => {
  const peer = decodedPeer();
  const onQosOneMessage = vi.fn<() => Promise<void>>(async () => {
    await Promise.resolve();
  });
  const opening = connectPortable(peer.transport, { clientId: '', onQosOneMessage }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'connack', reasonCode: 0, sessionPresent: false, properties: { assignedClientIdentifier: 'assigned' } });
  peer.receive()?.({ cmd: 'publish', qos: 1, messageId: 1, topic: 'a', payload: Buffer.alloc(0), dup: false, retain: false });
  peer.receive()?.({ cmd: 'auth', reasonCode: 0x18 });
  const failure = await opening;
  expect(failure).toMatchObject({ message: 'Unexpected MQTT AUTH', code: 0x82 });
  expect(onQosOneMessage).not.toHaveBeenCalled();
  expect(peer.sent).toEqual(['connect', 'disconnect']);
});

test('a refused empty-ID CONNACK owns failure before later AUTH', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: '' }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'connack', reasonCode: 0x85, sessionPresent: false });
  peer.receive()?.({ cmd: 'auth', reasonCode: 0x18 });
  expect(await opening).toMatchObject({ message: 'MQTT acknowledgment refused', code: 0x85 });
  expect(peer.sent).toEqual(['connect']);
});

test.each([
  connack([...assignment('first'), ...assignment('second')]),
  connack([0x12, 0, 1, 0xc0]),
  connack([0x12, 0, 1, 0]),
  [0x30, 7, 0, 1, 0x61, 3, 0x12, 0, 0],
])('portable codec rejects malformed or misplaced assignment %j at every split', (...bytes: readonly number[]) => {
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new PacketDecoder();
    const input = Uint8Array.from(bytes);
    expect(() => {
      decoder.push(input.subarray(0, split));
      decoder.push(input.subarray(split));
    }).toThrow(/Invalid|encoded data/u);
  }
});
function connack(properties: readonly number[], reason = 0): number[] {
  return [0x20, properties.length + 3, 0, reason, properties.length, ...properties];
}

test('portable codec preserves Assigned Client Identifier at every split and on encoding', () => {
  const bytes = Uint8Array.from(connack(assignment('\ufeff😀')));
  const packet = { cmd: 'connack' as const, reasonCode: 0, sessionPresent: false, assignedClientIdentifier: '\ufeff😀' };
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new PacketDecoder();
    expect([...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))]).toEqual([packet]);
  }
  expect(encodePacket(packet)).toEqual(bytes);
});

const adapters = ['tcp', 'node-websocket', 'browser'] as const;
const vectors = [
  { label: 'missing assignment', clientId: '', bytes: connack([]) },
  { label: 'empty assignment', clientId: '', bytes: connack(assignment('')) },
  { label: 'changed identity', clientId: 'named', bytes: connack(assignment('changed')) },
  { label: 'unsolicited method', clientId: 'named', bytes: connack([0x15, 0, 1, 0x78]) },
  { label: 'orphan data', clientId: 'named', bytes: connack([0x16, 0, 0]) },
  { label: 'AUTH before success', clientId: 'named', bytes: [0xf0, 0, ...connack([])] },
] as const;

test.each(
  adapters.flatMap((adapter) =>
    vectors.map((vector: Readonly<{ label: string; clientId: string; bytes: readonly number[] }>) => ({ adapter, ...vector })),
  ),
)(
  '$adapter rejects $label and closes before fixture cleanup',
  async ({
    adapter,
    clientId,
    bytes,
  }: Readonly<{ adapter: (typeof adapters)[number]; clientId: string; bytes: readonly number[] }>) => {
    const peer =
      adapter === 'tcp'
        ? await startTcpPacketPeer('fixed-connect', [...bytes, 0x30, 5, 0, 1, 0x61, 0, 0x78])
        : await startWebSocketPacketPeer('fixed-connect', [...bytes, 0x30, 5, 0, 1, 0x61, 0, 0x78]);
    const controller = new AbortController();
    const onMessage = vi.fn<() => void>();
    try {
      const options = { clientId, signal: controller.signal, timeoutMs: 1000, onMessage };
      const factory =
        'host' in peer
          ? createTcpClient({ ...peer, ...options })
          : adapter === 'browser'
            ? createBrowserClient({ ...peer, ...options })
            : createWebSocketClient({ ...peer, ...options });
      const opening = factory.connect();
      expect(factory.connect()).toBe(opening);
      const failure = await opening.catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(Error);
      await expect(factory.connect()).rejects.toBe(failure);
      await expect.poll(peer.connections).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(peer.commands).toEqual(['connect']);
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await peer.close();
    }
  },
);

test.each(adapters)('%s accepts an assigned empty ID', async (adapter) => {
  const bytes = connack(assignment('assigned-id'));
  const peer =
    adapter === 'tcp' ? await startTcpPacketPeer('fixed-connect', bytes) : await startWebSocketPacketPeer('fixed-connect', bytes);
  try {
    const options = { clientId: '', timeoutMs: 1000 };
    const factory =
      'host' in peer
        ? createTcpClient({ ...peer, ...options })
        : adapter === 'browser'
          ? createBrowserClient({ ...peer, ...options })
          : createWebSocketClient({ ...peer, ...options });
    const client = await factory.connect();
    await client.disconnect();
    await expect.poll(peer.connections).toBe(0);
  } finally {
    await peer.close();
  }
});

test.each(adapters)('%s retains an empty-ID refusal', async (adapter) => {
  const bytes = connack([], 0x85);
  const peer =
    adapter === 'tcp' ? await startTcpPacketPeer('fixed-connect', bytes) : await startWebSocketPacketPeer('fixed-connect', bytes);
  try {
    const options = { clientId: '', timeoutMs: 1000 };
    const factory =
      'host' in peer
        ? createTcpClient({ ...peer, ...options })
        : adapter === 'browser'
          ? createBrowserClient({ ...peer, ...options })
          : createWebSocketClient({ ...peer, ...options });
    await expect(factory.connect()).rejects.toMatchObject({ code: 0x85 });
    await expect.poll(peer.connections).toBe(0);
  } finally {
    await peer.close();
  }
});

test.each(adapters)('%s retires active AUTH before ping and publication suffixes', async (adapter) => {
  const bytes = [0xf0, 0, 0xd0, 0, 0x30, 5, 0, 1, 0x61, 0, 0x78];
  const peer =
    adapter === 'tcp' ? await startTcpPacketPeer('fixed-ping', bytes) : await startWebSocketPacketPeer('fixed-ping', bytes);
  const controller = new AbortController();
  const onMessage = vi.fn<() => void>();
  const ended = vi.fn<(notice: unknown) => void>();
  try {
    const options = { clientId: 'named', timeoutMs: 1000, signal: controller.signal, onMessage, onSessionEnd: ended };
    const factory =
      'host' in peer
        ? createTcpClient({ ...peer, ...options })
        : adapter === 'browser'
          ? createBrowserClient({ ...peer, ...options })
          : createWebSocketClient({ ...peer, ...options });
    const client = await factory.connect();
    const failure = await client.ping().catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(Error);
    await expect(client.ping()).rejects.toBe(failure);
    await expect.poll(peer.connections).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(onMessage).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0]?.[0]).toMatchObject({ kind: 'error', error: failure });
    const notice = ended.mock.calls[0]?.[0];
    if (typeof notice !== 'object' || notice === null || !('error' in notice)) throw new Error('Expected session error notice');
    expect(notice.error).toBe(failure);
  } finally {
    controller.abort();
    await peer.close();
  }
});
