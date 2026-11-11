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

test.each([
  { endpoint: 'mqtts://localhost:8884', host: 'localhost', servername: 'localhost' },
  { endpoint: 'mqtts://127.0.0.1:8884', host: '127.0.0.1', servername: undefined },
  { endpoint: 'mqtts://[::1]:8884', host: '::1', servername: undefined },
] as const)('legacy TLS separates hostname, port and SNI for $endpoint', ({ endpoint, host, servername }) => {
  const socket = new tls.TLSSocket(new Socket());
  const createConnection = vi.spyOn(tls, 'connect').mockReturnValue(socket);
  try {
    const connection = connectionFactory({ brokerUrl: new URL(endpoint) });
    expect(connection).toBe(socket);
    expect(createConnection).toHaveBeenCalledExactlyOnceWith({ port: 8884, host, servername });
  } finally {
    createConnection.mockRestore();
    socket.destroy();
  }
});

test('legacy TLS preserves explicit host, port and servername overrides', () => {
  const socket = new tls.TLSSocket(new Socket());
  const createConnection = vi.spyOn(tls, 'connect').mockReturnValue(socket);
  const tlsOptions = { host: 'override.invalid', port: 9883, servername: 'certificate.invalid' };
  try {
    const connection = connectionFactory({ brokerUrl: new URL('mqtts://localhost:8884'), tlsOptions });
    expect(connection).toBe(socket);
    expect(createConnection).toHaveBeenCalledExactlyOnceWith(tlsOptions);
  } finally {
    createConnection.mockRestore();
    socket.destroy();
  }
});
