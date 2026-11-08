import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { generate, parser, type ISubscribePacket } from 'mqtt-packet';
import { WebSocketServer } from 'ws';
import { expect, test, vi } from 'vitest';
import { createTcpClient } from '../src/tcpClient.js';
import { createWebSocketClient } from '../src/websocketClient.js';
import { createBrowserClient } from '../src/browserClient.js';

test.each(['tcp', 'websocket', 'browser'] as const)(
  'rejects invalid %s subscription limits before resource acquisition',
  async (kind) => {
    for (const limits of [
      { maxPendingSubscriptions: 0 },
      { maxPendingSubscriptions: 65_536 },
      { maxPendingSubscriptionBytes: 0 },
    ]) {
      let accesses = 0;
      const options = {
        clientId: 'invalid-subscriptions',
        ...limits,
        get host(): string {
          accesses++;
          throw new Error('Unexpected TCP acquisition');
        },
        get url(): string {
          accesses++;
          throw new Error('Unexpected WS acquisition');
        },
      };
      const factory =
        kind === 'tcp'
          ? createTcpClient(options)
          : kind === 'websocket'
            ? createWebSocketClient(options)
            : createBrowserClient(options);
      await expect(factory.connect()).rejects.toBeInstanceOf(RangeError);
      expect(accesses).toBe(0);
    }
  },
);

test.each([
  { kind: 'tcp', budget: 'entries' },
  { kind: 'tcp', budget: 'bytes' },
  { kind: 'websocket', budget: 'entries' },
  { kind: 'websocket', budget: 'bytes' },
  { kind: 'browser', budget: 'entries' },
  { kind: 'browser', budget: 'bytes' },
] as const)(
  'captures $kind $budget limits and routes reversed wire SUBACKs',
  async ({ kind, budget }: Readonly<{ kind: 'tcp' | 'websocket' | 'browser'; budget: 'entries' | 'bytes' }>) => {
    const tcp = createServer();

    const peers = new Set<Socket>();
    const subscriptions: ISubscribePacket[] = [];
    let acceptConnect!: () => void;
    const connected = new Promise<void>((resolve) => {
      acceptConnect = resolve;
    });
    let reply!: () => void;
    if (kind === 'tcp') {
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The wire fixture retains mutable native sockets and decoder-owned byte views.
      tcp.on('connection', (socket) => {
        peers.add(socket);
        const decoder = parser({ protocolVersion: 5 });
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The wire fixture retains mutable native sockets and decoder-owned byte views.
        socket.on('data', (bytes) => {
          decoder.parse(typeof bytes === 'string' ? Buffer.from(bytes) : bytes);
        });
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The native parser owns mutable packets in this wire fixture.
        decoder.on('packet', (packet) => {
          if (packet.cmd === 'connect') {
            reply = () => {
              socket.write(Buffer.from([0x20, 3, 0, 0, 0]));
            };
            acceptConnect();
          }
          if (packet.cmd === 'subscribe') subscriptions.push(packet);
          if (packet.cmd === 'disconnect') socket.end();
        });
      });
      tcp.listen(0, '127.0.0.1');
      await once(tcp, 'listening');
    }
    const server = kind === 'tcp' ? undefined : new WebSocketServer({ host: '127.0.0.1', port: 0 });
    if (server) {
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The wire fixture retains mutable native sockets and decoder-owned byte views.
      server.on('connection', (socket) => {
        const decoder = parser({ protocolVersion: 5 });
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The wire fixture retains mutable native sockets and decoder-owned byte views.
        socket.on('message', (bytes) => {
          if (Buffer.isBuffer(bytes)) decoder.parse(bytes);
        });
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The native parser owns mutable packets in this wire fixture.
        decoder.on('packet', (packet) => {
          if (packet.cmd === 'connect') {
            reply = () => {
              socket.send(Buffer.from([0x20, 3, 0, 0, 0]));
            };
            acceptConnect();
          }
          if (packet.cmd === 'subscribe') subscriptions.push(packet);
        });
      });
      await once(server, 'listening');
    }
    const address = server?.address() ?? tcp.address();
    if (address === null || typeof address === 'string') throw new Error('Expected listening address');
    const options = {
      host: '127.0.0.1',
      port: address.port,
      url: `ws://127.0.0.1:${address.port}`,
      clientId: 'wire-subscriptions',
      maxPendingSubscriptions: budget === 'entries' ? 2 : 4,
      maxPendingSubscriptionBytes: budget === 'bytes' ? 18 : 1024,
    };
    const factory =
      kind === 'tcp'
        ? createTcpClient(options)
        : kind === 'websocket'
          ? createWebSocketClient(options)
          : createBrowserClient(options);
    const opening = factory.connect();
    options.maxPendingSubscriptions = 1;
    options.maxPendingSubscriptionBytes = 1;
    try {
      await connected;
      reply();
      const client = await opening;
      const first = client.subscribe('a');
      const second = client.subscribe('b');
      const outcomes = Promise.allSettled([first, second]);
      try {
        await expect(client.subscribe('c')).rejects.toThrow('MQTT subscription capacity exceeded');
        await vi.waitFor(() => {
          expect(subscriptions).toHaveLength(2);
        });
        expect(subscriptions.map(({ messageId }: Readonly<{ messageId?: number }>) => messageId)).toEqual([1, 2]);
        for (const messageId of [2, 1]) {
          const bytes = generate({ cmd: 'suback', messageId, granted: [0] }, { protocolVersion: 5 });
          if (server) for (const socket of server.clients) socket.send(bytes);
          else for (const socket of peers) socket.write(bytes);
          await (messageId === 2 ? second : first);
        }
        await client.disconnect();
      } finally {
        for (const socket of peers) socket.destroy();
        if (server) for (const socket of server.clients) socket.terminate();
        await outcomes;
      }
    } finally {
      for (const socket of peers) socket.destroy();
      if (server) for (const socket of server.clients) socket.terminate();
      await opening.catch(() => {});
      if (server)
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      else
        await new Promise<void>((resolve) => {
          tcp.close(() => {
            resolve();
          });
        });
    }
  },
);
