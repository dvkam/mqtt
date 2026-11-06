import { once } from 'node:events';
import { generate, parser, type Packet } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { WebSocketServer } from 'ws';
import { createWebSocketClient } from '../src/index.js';

async function peer(earlyPublish = false) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  const packets: Packet[] = [];
  server.on('connection', (socket) => {
    const codec = { protocolVersion: 5 };
    const decoder = parser(codec);
    socket.on('message', (data) => {
      if (Buffer.isBuffer(data)) decoder.parse(data);
    });
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
      if (packet.cmd === 'subscribe') socket.terminate();
    });
  });
  return {
    server,
    url: 'ws://127.0.0.1:' + address.port,
    packets,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('rejects a packet above the write budget without sending it and can still disconnect', async () => {
  const broker = await peer();
  try {
    const client = await createWebSocketClient({ url: broker.url, clientId: 'budget', maxBufferedBytes: 128 }).connect();
    await expect(client.publish('budget', 'x'.repeat(256))).rejects.toThrow('WebSocket write budget exceeded');
    await client.disconnect();
    expect(broker.packets.map(({ cmd }) => cmd)).toEqual(['connect', 'disconnect']);
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
    expect(broker.packets.map(({ cmd }) => cmd)).toEqual(['connect', 'subscribe']);
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
      onMessage: (packet) => delivered.push(packet),
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
    const socket = [...broker.server.clients][0]!;
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
