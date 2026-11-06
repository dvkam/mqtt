import { once } from 'node:events';
import { createConnection } from 'node:net';
import { generate, parser } from 'mqtt-packet';
import { connectPortable, type PacketTransport } from './portable.js';

type TcpClientOptions = Parameters<typeof connectPortable>[1] & { host: string; port?: number };

export function createTcpClient(options: TcpClientOptions) {
  let connection: ReturnType<typeof connectPortable> | undefined;
  return {
    connect() {
      connection ??= openTcpClient(options);
      return connection;
    },
  };
}

async function openTcpClient(options: TcpClientOptions) {
  const socket = createConnection({ host: options.host, port: options.port ?? 1883 });
  const codec = { protocolVersion: 5 };
  const decoder = parser(codec);
  let socketError: Error | undefined;
  socket.on('error', (error) => {
    socketError = error;
  });
  socket.on('data', (chunk) => decoder.parse(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
  decoder.on('error', (error) => socket.destroy(error));

  const transport: PacketTransport = {
    send(packet) {
      return new Promise((resolve, reject) => {
        socket.write(generate(packet, codec), (error) => (error ? reject(error) : resolve()));
      });
    },
    listen(onPacket, onClose) {
      const closed = () => onClose(socketError ?? new Error('TCP socket closed'));
      decoder.on('packet', onPacket);
      socket.on('close', closed);
      return () => {
        decoder.off('packet', onPacket);
        socket.off('close', closed);
      };
    },
    async close() {
      if (socket.destroyed) return;
      const closed = new Promise<void>((resolve) => socket.once('close', resolve));
      socket.destroySoon();
      await closed;
    },
  };

  const timer = setTimeout(() => socket.destroy(new Error('TCP connection timed out')), options.timeoutMs ?? 3000);
  try {
    await once(socket, 'connect');
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return connectPortable(transport, options);
}
