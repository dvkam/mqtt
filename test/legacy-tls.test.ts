import { Socket } from 'node:net';
import tls from 'node:tls';
import { expect, test, vi } from 'vitest';
import { connectionFactory } from '../src/connectionFactory/index.js';

test('a legacy TLS error reaches the caller once and closes the socket', async () => {
  const socket = new tls.TLSSocket(new Socket());
  const connect = vi.spyOn(tls, 'connect').mockReturnValue(socket);
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      resolve();
    });
  });
  const observed: Array<Readonly<{ error: unknown; destroyed: boolean }>> = [];
  const failure = new Error('TLS handshake failed');
  try {
    const connection = connectionFactory({ brokerUrl: new URL('mqtts://localhost'), tlsOptions: {} });
    connection.on('error', (error: unknown) => {
      observed.push({ error, destroyed: socket.destroyed });
    });
    expect(() => socket.emit('error', failure)).not.toThrow();
    expect(socket.destroyed).toBe(true);
    await closed;
    expect(observed).toHaveLength(1);
    expect(observed[0]?.error).toBe(failure);
    expect(observed[0]?.destroyed).toBe(true);
  } finally {
    connect.mockRestore();
    socket.destroy();
    await closed;
  }
});
