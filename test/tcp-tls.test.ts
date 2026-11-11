import { getEventListeners, once } from 'node:events';
import { createServer, Socket } from 'node:net';
import tls from 'node:tls';
import { setImmediate } from 'node:timers/promises';
import { expect, test, vi } from 'vitest';
import { createTcpClient } from '../src/index.js';

test('TLS opening sends no MQTT CONNECT before authentication and preserves abort identity', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP server address');
  const accepted = once(server, 'connection');
  const controller = new AbortController();
  const cause = new Error('Stop the pending TLS handshake');
  const connections = vi.spyOn(tls, 'connect');
  let restoreWrite = () => {};
  let peer: Socket | undefined;
  try {
    const options = { host: '127.0.0.1', port: address.port, clientId: 'tls-opening', signal: controller.signal, tls: {} };
    const factory = createTcpClient(options);
    const opening = factory.connect();
    const failure = opening.catch((reason: unknown) => reason);
    expect(factory.connect()).toBe(opening);
    expect(connections).toHaveBeenCalledTimes(1);
    const result = connections.mock.results[0];
    if (result?.type !== 'return') throw new Error('Expected native TLS socket');
    const writes = vi.spyOn(result.value, 'write');
    restoreWrite = () => {
      writes.mockRestore();
    };
    const connected = once(result.value, 'connect');
    const closed = new Promise<void>((resolve) => {
      result.value.once('close', () => {
        resolve();
      });
    });
    const [acceptedSocket]: readonly unknown[] = await accepted;
    if (!(acceptedSocket instanceof Socket)) throw new Error('Expected accepted TCP socket');
    peer = acceptedSocket;
    peer.on('error', () => {});
    await connected;
    await setImmediate();
    expect(writes.mock.calls.some(([bytes]: readonly unknown[]) => Buffer.isBuffer(bytes) && bytes[0] === 0x10)).toBe(false);
    controller.abort(cause);
    expect(await failure).toBe(cause);
    await closed;
    expect(result.value.destroyed).toBe(true);
  } finally {
    controller.abort(cause);
    peer?.destroy();
    connections.mockRestore();
    restoreWrite();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

test('TLS handshake timeout closes the socket and removes cancellation ownership', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP server address');
  const accepted = once(server, 'connection');
  const controller = new AbortController();
  let peer: Socket | undefined;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const opening = createTcpClient({
      host: '127.0.0.1',
      port: address.port,
      clientId: 'tls-timeout',
      tls: {},
      signal: controller.signal,
      timeoutMs: 2000,
    })
      .connect()
      .catch((reason: unknown) => reason);
    const [acceptedSocket]: readonly unknown[] = await accepted;
    if (!(acceptedSocket instanceof Socket)) throw new Error('Expected accepted TCP socket');
    peer = acceptedSocket;
    peer.on('error', () => {});
    vi.advanceTimersByTime(2000);
    expect(await opening).toMatchObject({ message: 'TLS connection timed out' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  } finally {
    controller.abort();
    vi.useRealTimers();
    peer?.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

test('a pre-aborted TLS attempt opens no native socket', async () => {
  const cause = new Error('TLS connection canceled before setup');
  const connections = vi.spyOn(tls, 'connect');
  try {
    await expect(
      createTcpClient({
        host: 'localhost',
        clientId: 'tls-pre-abort',
        tls: {},
        signal: AbortSignal.abort(cause),
      }).connect(),
    ).rejects.toBe(cause);
    expect(connections).not.toHaveBeenCalled();
  } finally {
    connections.mockRestore();
  }
});
