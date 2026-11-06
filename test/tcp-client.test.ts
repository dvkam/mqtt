import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { generate, parser } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { createTcpClient } from '../src/index.js';

test('opens no TCP connection during construction and one when connect is called', async () => {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  let opened = 0;
  const broker = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    opened++;
    const codec = { protocolVersion: 5 };
    const decoder = parser(codec);
    socket.on('data', (chunk) => decoder.parse(chunk));
    decoder.on('packet', (packet) => {
      commands.push(packet.cmd);
      if (packet.cmd === 'connect') socket.write(generate({ cmd: 'connack', reasonCode: 0, sessionPresent: false }, codec));
      if (packet.cmd === 'disconnect') socket.end();
    });
  });
  broker.listen(0, '127.0.0.1');
  await once(broker, 'listening');
  try {
    const address = broker.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    const client = createTcpClient({ host: '127.0.0.1', port: address.port, clientId: 'tcp-tracer' });
    await setTimeout(25);
    expect(opened).toBe(0);

    const connected = await client.connect();
    expect(opened).toBe(1);
    expect(commands).toEqual(['connect']);
    const socket = [...sockets][0]!;
    const closed = once(socket, 'close');
    await connected.disconnect();
    await closed;
    expect(commands).toEqual(['connect', 'disconnect']);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  }
});
