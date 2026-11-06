import { createConnection } from 'node:net';
import { generate, parser } from 'mqtt-packet';
import { connectPortable, type PacketTransport } from './portable.js';

type TcpClientOptions = Parameters<typeof connectPortable>[1] & { host: string; port?: number; signal?: AbortSignal };

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
  const { signal } = options;
  const abortReason = () => {
    const reason: unknown = signal?.reason;
    return reason instanceof Error ? reason : Object.assign(new Error('TCP connection aborted'), { name: 'AbortError' });
  };
  if (signal?.aborted) throw abortReason();

  const socket = createConnection({ host: options.host, port: options.port ?? 1883 });
  const codec = { protocolVersion: 5 };
  const decoder = parser(codec);
  let socketError: Error | undefined;
  socket.on('error', (error) => {
    socketError = error;
  });
  const closed = new Promise<void>((resolve) => socket.once('close', resolve));
  const abort = () => socket.destroy(abortReason());
  signal?.addEventListener('abort', abort, { once: true });
  socket.on('data', (chunk) => {
    try {
      decoder.parse(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error('TCP packet handler failed'));
    }
  });
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
    async close(force) {
      if (!socket.destroyed) {
        if (force) socket.destroy();
        else socket.destroySoon();
      }
      await closed;
    },
  };

  const timer = setTimeout(() => socket.destroy(new Error('TCP connection timed out')), options.timeoutMs ?? 3000);
  try {
    await new Promise<void>((resolve, reject) => {
      const connected = () => {
        socket.off('close', failed);
        resolve();
      };
      const failed = () => {
        socket.off('connect', connected);
        reject(socketError ?? new Error('TCP socket closed before connecting'));
      };
      socket.once('connect', connected);
      socket.once('close', failed);
    });
    clearTimeout(timer);
    const client = await connectPortable(transport, options);
    if (signal?.aborted) throw abortReason();
    return client;
  } catch (error) {
    await transport.close(true);
    if (signal?.aborted) throw abortReason();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
