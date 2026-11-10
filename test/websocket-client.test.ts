import { once } from 'node:events';
import { Socket } from 'node:net';
import { generate, parser, type Packet } from 'mqtt-packet';
import { expect, test, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createWebSocketClient } from '../src/index.js';

async function peer(earlyPublish = false, subscriptionReply?: readonly number[]) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  const packets: Packet[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  server.on('connection', (socket) => {
    const codec = { protocolVersion: 5 };
    const decoder = parser(codec);
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    socket.on('message', (data) => {
      if (Buffer.isBuffer(data)) decoder.parse(data);
    });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    decoder.on('packet', (packet) => {
      packets.push(packet);
      if (packet.cmd === 'connect') {
        if (earlyPublish)
          socket.send(
            generate(
              {
                cmd: 'publish',
                qos: 0,
                dup: false,
                retain: false,
                topic: 'early',
                payload: 'early',
              },
              codec,
            ),
          );
        socket.send(generate({ cmd: 'connack', reasonCode: 0, sessionPresent: false }, codec));
      }
      if (packet.cmd === 'subscribe' || packet.cmd === 'unsubscribe') {
        if (subscriptionReply) socket.send(Buffer.from(subscriptionReply));
        else socket.terminate();
      }
      if (packet.cmd === 'pingreq') socket.send(generate({ cmd: 'pingresp' }, codec));
    });
  });
  return {
    server,
    url: 'ws://127.0.0.1:' + address.port,
    packets,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

test('rejects a packet above the write budget without sending it and can still disconnect', async () => {
  const broker = await peer();
  try {
    const client = await createWebSocketClient({ url: broker.url, clientId: 'budget', maxBufferedBytes: 128 }).connect();
    await expect(client.publish('budget', 'x'.repeat(256))).rejects.toThrow('WebSocket write budget exceeded');
    await client.disconnect();
    expect(broker.packets.map(({ cmd }: Readonly<{ cmd: string }>) => cmd)).toEqual(['connect', 'disconnect']);
  } finally {
    await broker.close();
  }
});

test('settles a pending operation and refuses later sends when the WebSocket closes', async () => {
  const broker = await peer();
  try {
    const client = await createWebSocketClient({ url: broker.url, clientId: 'peer-close' }).connect();
    await expect(client.subscribe('close')).rejects.toThrow('MQTT WebSocket closed');
    await expect(client.publish('close', 'late')).rejects.toThrow('MQTT WebSocket closed');
    expect(broker.packets.map(({ cmd }: Readonly<{ cmd: string }>) => cmd)).toEqual(['connect', 'subscribe']);
  } finally {
    await broker.close();
  }
});

test('does not deliver application messages before MQTT connection acceptance', async () => {
  const broker = await peer(true);
  try {
    const delivered: Packet[] = [];
    const client = await createWebSocketClient({
      url: broker.url,
      clientId: 'early',
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
      onMessage: (packet) => {
        delivered.push(packet);
      },
    }).connect();
    await client.disconnect();
    expect(delivered).toEqual([]);
  } finally {
    await broker.close();
  }
});

test('terminates an unresponsive peer when the local close deadline expires', async () => {
  const broker = await peer();
  try {
    const client = await createWebSocketClient({ url: broker.url, clientId: 'local-close', timeoutMs: 250 }).connect();
    const socket = [...broker.server.clients][0];
    if (socket === undefined) throw new Error('Expected connected socket');
    socket.pause();
    const start = performance.now();
    const closing = client.disconnect();
    expect(client.disconnect()).toBe(closing);
    await closing;
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(1500);
    await expect(client.publish('close', 'late')).rejects.toThrow('closing');
  } finally {
    await broker.close();
  }
});

test('Node WebSocket publication pressure leaves native admission room for control', async () => {
  const broker = await peer();
  let restore: (() => void) | undefined;
  try {
    const options = { url: broker.url, clientId: 'reserve', maxBufferedBytes: 32, reservedControlBytes: 8 };
    const opening = createWebSocketClient(options).connect();
    options.maxBufferedBytes = 1;
    options.reservedControlBytes = 1;
    const client = await opening;
    const queued = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(12);
    restore = () => {
      queued.mockRestore();
    };
    await client.publish('a', '');
    queued.mockReturnValue(24);
    await expect(client.publish('a', '')).rejects.toThrow('WebSocket write budget exceeded');
    await client.ping();
    queued.mockReturnValue(0);
    await client.disconnect();
    expect(broker.packets.map(({ cmd }: Readonly<Pick<Packet, 'cmd'>>) => cmd)).toEqual([
      'connect',
      'publish',
      'pingreq',
      'disconnect',
    ]);
  } finally {
    restore?.();
    await broker.close();
  }
});

test.each([
  [0, 6, 6],
  [119, 125, 6],
  [120, 126, 8],
  [65_527, 65_535, 8],
  [65_528, 65_536, 14],
])('Node WS reserves framed bytes for payload length %s', async (payloadLength, mqttBytes, headerBytes) => {
  const broker = await peer();
  const writes = vi.spyOn(Socket.prototype, 'write');
  let owner: Socket | undefined;
  try {
    const address = broker.server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
    const frameBytes = mqttBytes + headerBytes;
    const client = await createWebSocketClient({
      url: broker.url,
      clientId: 'a',
      maxBufferedBytes: frameBytes + 16,
      reservedControlBytes: 16,
    }).connect();
    const connected: unknown = writes.mock.contexts.find(
      (candidate: unknown) => candidate instanceof Socket && candidate.remotePort === address.port,
    );
    writes.mockRestore();
    if (!(connected instanceof Socket)) throw new Error('Expected WS client socket');
    owner = connected;
    owner.cork();
    const excess = client.publish('a', 'x'.repeat(payloadLength + 1)).catch((reason: unknown) => reason);
    expect(owner.writableLength).toBe(0);
    await expect(excess).resolves.toMatchObject({ message: 'WebSocket write budget exceeded' });
    const publication = client.publish('a', 'x'.repeat(payloadLength)).catch((reason: unknown) => reason);
    expect(owner.writableLength).toBe(frameBytes);
    const ping = client.ping();
    expect(owner.writableLength).toBe(frameBytes + 8);
    expect(broker.packets.map(({ cmd }: Readonly<Pick<Packet, 'cmd'>>) => cmd)).toEqual(['connect']);
    owner.uncork();
    await expect(publication).resolves.toBeUndefined();
    await ping;
    expect(broker.packets.map(({ cmd }: Readonly<Pick<Packet, 'cmd'>>) => cmd)).toEqual(['connect', 'publish', 'pingreq']);
    await client.disconnect();
  } finally {
    writes.mockRestore();
    owner?.uncork();
    owner?.destroy();
    await broker.close();
  }
});

test.each([
  { command: 'subscribe', bytes: [0x90, 4, 0, 1, 0, 17] },
  { command: 'unsubscribe', bytes: [0xb0, 4, 0, 1, 0, 1] },
] as const)(
  'reports a parser-rejected $command reply over Node WebSocket before closing',
  async ({ command, bytes }: Readonly<{ command: 'subscribe' | 'unsubscribe'; bytes: readonly number[] }>) => {
    const broker = await peer(false, bytes);
    try {
      const client = await createWebSocketClient({ url: broker.url, clientId: 'suback-protocol' }).connect();
      const failure = await client[command]('a').catch((reason: unknown) => reason);
      expect(failure).toMatchObject({ code: 0x82 });
      await expect(client.ping()).rejects.toBe(failure);
      await expect.poll(() => broker.packets[2]).toMatchObject({ cmd: 'disconnect', reasonCode: 0x82 });
    } finally {
      await broker.close();
    }
  },
);

test('Node WebSocket diagnostics keep URL credentials out of observer events', async () => {
  const broker = await peer();
  try {
    const url = new URL(broker.url);
    url.username = 'private-url-user';
    url.password = 'private-url-password';
    const events: unknown[] = [];
    const client = await createWebSocketClient({
      url,
      clientId: 'private-id',
      onDiagnostic(event: unknown) {
        events.push(event);
      },
    }).connect();
    await client.disconnect();
    expect(events).toEqual([
      { kind: 'packet', direction: 'outbound', command: 'connect' },
      { kind: 'packet', direction: 'inbound', command: 'connack' },
      { kind: 'connection', state: 'active' },
      { kind: 'packet', direction: 'outbound', command: 'disconnect' },
      { kind: 'connection', state: 'retired' },
    ]);
  } finally {
    await broker.close();
  }
});
