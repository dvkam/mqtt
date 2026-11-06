import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { expect, test } from 'vitest';
import { buildWebSocketStream } from '../src/connectionFactory/buildWebSocketStream.js';

test('negotiates MQTT, transfers binary bytes and closes the Node WebSocket stream', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  const url = new URL('ws://127.0.0.1:' + address.port);
  const handshake = new AbortController();
  const signal = AbortSignal.any([handshake.signal, AbortSignal.timeout(2000)]);
  let stream: ReturnType<typeof buildWebSocketStream> | undefined;
  try {
    const accepted = once(server, 'connection', { signal });
    void accepted.catch(() => {});
    stream = buildWebSocketStream({
      url,
      hostname: url.hostname,
      port: address.port,
      path: '/',
      protocol: 'ws:',
      websocketSubProtocol: 'mqtt',
      wsOptions: {},
    });
    const failed = once(stream, 'error', { signal }).then(([error]) => {
      throw error;
    });
    const [peer] = await Promise.race([accepted, failed]);
    expect(peer.protocol).toBe('mqtt');
    const message = once(peer, 'message');
    const bytes = Buffer.from([0xc0, 0x00]);
    stream.write(bytes);
    const [received, binary] = await message;
    expect(binary).toBe(true);
    expect(received).toEqual(bytes);

    const response = once(stream, 'data');
    peer.send(Buffer.from([0xd0, 0x00]));
    await expect(response).resolves.toEqual([Buffer.from([0xd0, 0x00])]);

    const closed = once(stream, 'close');
    peer.close(1000);
    await closed;
    expect(stream.destroyed).toBe(true);
  } finally {
    handshake.abort();
    stream?.destroy();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
