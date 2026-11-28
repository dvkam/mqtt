import { getEventListeners } from 'node:events';
import { expect, test, vi } from 'vitest';
import { connectPortable, type PacketTransport } from '../src/portable.js';
import { ProtocolInputError } from '../src/protocolInputError.js';
import { createTcpClient, createTransportClient, type ByteInbound, type ClientSession } from '../src/index.js';
import { createWebSocketClient } from '../src/ws.js';
import { createBrowserClient } from '../src/browser.js';
import { PacketDecoder, encodePacket } from '../src/codec.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';
import { entryAt } from './experiments/entry.js';

function decodedPeer(onListen?: () => void) {
  let receive: Parameters<PacketTransport['listen']>[0] | undefined;
  let closed: Parameters<PacketTransport['listen']>[1] | undefined;
  let protocolError: Parameters<PacketTransport['listen']>[2];
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
    listen(onPacket, onClose, onProtocolError) {
      receive = onPacket;
      closed = onClose;
      protocolError = onProtocolError;
      onListen?.();
      return () => {};
    },
    close,
  };
  return {
    transport,
    close,
    sent,
    clientIds,
    receive: () => receive,
    closed: () => closed,
    // The Node listener reports a broker AUTH to the session as this protocol error.
    rejectAuth: () => {
      protocolError?.(new ProtocolInputError('Unexpected MQTT AUTH', 0x82));
    },
  };
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
    peer.receive()?.({ cmd: 'connack', reasonCode: 0, sessionPresent: false, ...properties });
    peer.receive()?.({ cmd: 'publish', qos: 0, topic: 'a', payload: Buffer.from('suffix'), dup: false, retain: false });
    const failure = await opening;
    expect(failure).toMatchObject({ message: 'Unexpected MQTT authentication properties', reasonCode: 0x82 });
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
    peer.receive()?.({ cmd: 'connack', reasonCode: 0, sessionPresent: false, ...properties });
    expect(await opening).toMatchObject({ message: 'Invalid MQTT Assigned Client Identifier', reasonCode: 0x82 });
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
    const reply = { cmd: 'connack' as const, reasonCode: 0, sessionPresent: false, assignedClientIdentifier: assigned };
    peer.receive()?.(reply);
    reply.assignedClientIdentifier = '';
    const client = await opening;
    await client.disconnect();
    expect(peer.sent).toEqual(['connect', 'disconnect']);
  },
);

test('AUTH before CONNACK owns failure before a later refusal and close', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: 'named' }).catch((reason: unknown) => reason);
  peer.rejectAuth();
  peer.receive()?.({ cmd: 'connack', reasonCode: 0x87, sessionPresent: false });
  peer.closed()?.(new Error('later close'));
  expect(await opening).toMatchObject({ message: 'Unexpected MQTT AUTH', reasonCode: 0x82 });
  expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
});

test('active AUTH retires a pending ping and blocks the suffix with one error', async () => {
  const peer = decodedPeer();
  const onMessage = vi.fn<() => void>();
  const opening = connectPortable(peer.transport, { clientId: 'named', onMessage });
  peer.receive()?.({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
  const client = await opening;
  const pending = client.ping().catch((reason: unknown) => reason);
  peer.rejectAuth();
  peer.receive()?.({ cmd: 'pingresp' });
  peer.receive()?.({ cmd: 'publish', qos: 0, topic: 'a', payload: Buffer.alloc(0), dup: false, retain: false });
  const failure = await pending;
  expect(failure).toMatchObject({ message: 'Unexpected MQTT AUTH', reasonCode: 0x82 });
  await expect(client.ping()).rejects.toBe(failure);
  expect(onMessage).not.toHaveBeenCalled();
  expect(peer.sent).toEqual(['connect', 'pingreq', 'disconnect']);
});

test('an empty requested ID preserves a refusal instead of requiring assignment', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: '' }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'connack', reasonCode: 0x85, sessionPresent: false });
  expect(await opening).toMatchObject({ message: 'MQTT acknowledgment refused', code: 'ERR_MQTT_REFUSED', reasonCode: 0x85 });
});

test('exposes the validated assigned identifier and a frozen broker capability snapshot', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: '' });
  const userProperties: [string, string][] = [['origin', 'broker']];
  const reply = {
    cmd: 'connack' as const,
    reasonCode: 0,
    sessionPresent: false,
    assignedClientIdentifier: 'assigned-id',
    receiveMaximum: 7,
    maximumQoS: 1,
    retainAvailable: false,
    maximumPacketSize: 4096,
    userProperties,
  };
  peer.receive()?.(reply);
  reply.assignedClientIdentifier = 'changed';
  entryAt(userProperties, 0)[1] = 'changed';
  const client = await opening;
  expect(client.connection).toMatchObject({
    clientId: 'assigned-id',
    sessionPresent: false,
    receiveMaximum: 7,
    maximumQos: 1,
    retainAvailable: false,
    maximumPacketSize: 4096,
    userProperties: [['origin', 'broker']],
  });
  expect(Object.isFrozen(client.connection)).toBe(true);
  expect(Object.isFrozen(client.connection.userProperties?.[0])).toBe(true);
  expect(Reflect.set(client, 'connection', {})).toBe(false);
  await client.disconnect();
});

test('a refusal does not read unused success capabilities', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: 'before-capabilities' });
  peer.receive()?.({
    cmd: 'connack',
    reasonCode: 0x87,
    sessionPresent: false,
    get assignedClientIdentifier() {
      peer.closed()?.(new Error('close while reading assignment'));
      return 'unused';
    },
    get receiveMaximum() {
      peer.closed()?.(new Error('close while reading capabilities'));
      return 1;
    },
  });
  await expect(opening).rejects.toMatchObject({
    message: 'MQTT acknowledgment refused',
    code: 'ERR_MQTT_REFUSED',
    reasonCode: 0x87,
  });
});

test('forbidden CONNACK authentication is rejected before the reason field is read', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: 'auth-first' });
  const reason = vi.fn<() => number>(() => {
    peer.closed()?.(new Error('later close'));
    return 0;
  });
  peer.receive()?.({
    cmd: 'connack',
    sessionPresent: false,
    authenticationMethod: 'AUTH',
    get reasonCode() {
      return reason();
    },
  });
  await expect(opening).rejects.toMatchObject({
    message: 'Unexpected MQTT authentication properties',
    code: 'ERR_MQTT_PROTOCOL',
    reasonCode: 0x82,
  });
  expect(reason).not.toHaveBeenCalled();
});

test('invalid decoded capability does not deliver or replace a pending CONNECT failure', async () => {
  const peer = decodedPeer();
  const onMessage = vi.fn<() => void>();
  const opening = connectPortable(peer.transport, { clientId: 'invalid-capability', onMessage });
  const writeFailure = new Error('CONNECT transport failed');
  peer.receive()?.({ cmd: 'connack', reasonCode: 0, sessionPresent: false, receiveMaximum: 0 });
  peer.receive()?.({ cmd: 'publish', qos: 0, topic: 'a', payload: Buffer.from('early'), dup: false, retain: false });
  peer.closed()?.(writeFailure);
  await expect(opening).rejects.toBe(writeFailure);
  expect(onMessage).not.toHaveBeenCalled();
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
  peer.receive()?.({ cmd: 'connack', reasonCode: 0, sessionPresent: false, assignedClientIdentifier: 'original' });
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
  peer.receive()?.({ cmd: 'connack', reasonCode: 0, sessionPresent: false, assignedClientIdentifier: 'assigned' });
  peer.receive()?.({ cmd: 'publish', qos: 1, messageId: 1, topic: 'a', payload: Buffer.alloc(0), dup: false, retain: false });
  peer.rejectAuth();
  const failure = await opening;
  expect(failure).toMatchObject({ message: 'Unexpected MQTT AUTH', reasonCode: 0x82 });
  expect(onQosOneMessage).not.toHaveBeenCalled();
  expect(peer.sent).toEqual(['connect', 'disconnect']);
});

test('a refused empty-ID CONNACK owns failure before later AUTH', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: '' }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'connack', reasonCode: 0x85, sessionPresent: false });
  peer.rejectAuth();
  expect(await opening).toMatchObject({ message: 'MQTT acknowledgment refused', code: 'ERR_MQTT_REFUSED', reasonCode: 0x85 });
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
    }).toThrow(/Invalid|Duplicate/u);
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
const openingEchoes = [0x30, 5, 0, 1, 0x61, 0, 0x78, 0x30, 5, 0, 1, 0x62, 0, 0x79] as const;

test('delivers the accepted prefix and fences input when the pending CONNECT write rejects', async () => {
  let inbound: ByteInbound | undefined;
  let rejectWrite: ((reason: Readonly<Error>) => void) | undefined;
  let startedWriting = () => {};
  const writing = new Promise<void>((resolve) => {
    startedWriting = resolve;
  });
  const pendingWrite = new Promise<void>((_, reject) => {
    rejectWrite = reject;
  });
  const topics: string[] = [];
  const factory = createTransportClient(
    {
      name: 'opening write peer',
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Store the native endpoint so the fixture can send coalesced bytes.
      async open(input) {
        inbound = input;
        return Promise.resolve({
          bufferedBytes: 0,
          // oxlint-disable-next-line typescript/promise-function-async -- Expose the actual native write rejection without an extra async wrapper.
          write() {
            startedWriting();
            return pendingWrite;
          },
          async close() {
            return Promise.resolve();
          },
        });
      },
    },
    {
      clientId: 'opening-write',
      onMessage(message: Readonly<{ topic: string }>) {
        topics.push(message.topic);
      },
    },
  );
  const opening = factory.connect().catch((cause: unknown) => cause);
  await writing;
  inbound?.bytes(Uint8Array.from([...connack([]), ...openingEchoes.slice(0, 7)]));
  expect(topics).toEqual(['a']);
  const error = new Error('CONNECT write failed');
  rejectWrite?.(error);
  await Promise.resolve();
  inbound?.bytes(Uint8Array.from(openingEchoes.slice(7)));
  expect(await opening).toBe(error);
  expect(topics).toEqual(['a']);
});

test.each(adapters.flatMap((adapter) => [0, 0x87].map((reason) => ({ adapter, reason }))))(
  '$adapter handles the QoS 0 publications in the same input as CONNACK reason $reason',
  async ({ adapter, reason }: Readonly<{ adapter: (typeof adapters)[number]; reason: number }>) => {
    const bytes = [...connack([], reason), ...openingEchoes];
    const peer =
      adapter === 'tcp' ? await startTcpPacketPeer('fixed-connect', bytes) : await startWebSocketPacketPeer('fixed-connect', bytes);
    const replies: string[] = [];
    const options = {
      clientId: 'opening-echo',
      timeoutMs: 1000,
      onMessage(message: Readonly<{ topic: string; payload: Readonly<ArrayLike<number>> }>) {
        replies.push(`${message.topic}:${message.payload[0]}`);
      },
    };
    try {
      const factory =
        'host' in peer
          ? createTcpClient({ ...peer, ...options })
          : adapter === 'browser'
            ? createBrowserClient({ ...peer, ...options })
            : createWebSocketClient({ ...peer, ...options });
      const outcome = await factory.connect().then(
        (session: Readonly<ClientSession>) => ({ kind: 'connected' as const, session }),
        (error: unknown) => ({ kind: 'refused' as const, error }),
      );
      expect(outcome).toMatchObject(
        reason === 0 ? { kind: 'connected' } : { kind: 'refused', error: { code: 'ERR_MQTT_REFUSED', reasonCode: reason } },
      );
      expect(replies).toEqual(reason === 0 ? ['a:120', 'b:121'] : []);
      if (outcome.kind === 'connected') await outcome.session.disconnect();
    } finally {
      await peer.close();
    }
  },
);

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
    await expect(factory.connect()).rejects.toMatchObject({ code: 'ERR_MQTT_REFUSED', reasonCode: 0x85 });
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
    // Every adapter rejects AUTH in the inbound rules and sends DISCONNECT 0x82. The browser did so too once it moved onto
    // the shared core; before, its decoder rejected AUTH with a plain error and sent no DISCONNECT.
    expect(failure).toMatchObject({ message: 'Unexpected MQTT AUTH', reasonCode: 0x82 });
    await expect.poll(() => peer.disconnectReasons).toEqual([0x82]);
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
