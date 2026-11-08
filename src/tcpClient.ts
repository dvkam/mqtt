import { createConnection } from 'node:net';
import { generate, parser } from 'mqtt-packet';
import { connectPortable, type PacketTransport, type PortableOptions } from './portable.js';
import type { ClientFactory } from './session.js';
import type { NodeMessage } from './nodeMessage.js';
import { nodePacketListener } from './nodePacketListener.js';

export interface TcpClientOptions extends PortableOptions<NodeMessage> {
  host: string;
  port?: number;
  signal?: AbortSignal;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The TCP adapter uses native signals, sockets and shared packet buffers.
export function createTcpClient(options: Readonly<TcpClientOptions>): ClientFactory {
  let connection: ReturnType<typeof connectPortable> | undefined;
  return {
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    connect() {
      connection ??= openTcpClient(options);
      return connection;
    },
  };
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The TCP adapter uses native signals, sockets and shared packet buffers.
async function openTcpClient(options: Readonly<TcpClientOptions>) {
  const { signal } = options;
  const isAborted = (): boolean => signal?.aborted === true;
  const abortReason = () => {
    const reason: unknown = signal?.reason;
    return reason instanceof Error ? reason : Object.assign(new Error('TCP connection aborted'), { name: 'AbortError' });
  };
  if (isAborted()) throw abortReason();

  const socket = createConnection({ host: options.host, port: options.port ?? 1883 });
  const codec = { protocolVersion: 5 };
  const decoder = parser(codec);
  let socketError: Error | undefined;
  let failSession: ((reason: Readonly<Error>) => void) | undefined;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The TCP adapter uses native signals, sockets and shared packet buffers.
  socket.on('error', (error) => {
    socketError = error;
  });
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    });
  });
  const abort = () => {
    const reason = socketError ?? abortReason();
    socketError = reason;
    failSession?.(reason);
    socket.destroy(reason);
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (isAborted()) abort();
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The TCP adapter uses native signals, sockets and shared packet buffers.
  socket.on('data', (chunk) => {
    try {
      decoder.parse(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error('TCP packet handler failed'));
    }
  });
  decoder.on('error', (error: unknown) => {
    socket.destroy(error instanceof Error ? error : new Error('MQTT parser failed'));
  });

  const transport: PacketTransport<NodeMessage> = {
    // oxlint-disable-next-line typescript/promise-function-async, typescript/prefer-readonly-parameter-types -- Forward the existing promise without adding an async wrapper. The TCP adapter uses native signals, sockets and shared packet buffers.
    send(packet) {
      return new Promise((resolve, reject) => {
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The TCP adapter uses native signals, sockets and shared packet buffers.
        socket.write(generate(packet, codec), (error) => {
          error ? reject(error) : resolve();
        });
      });
    },
    listen(onPacket, onClose) {
      failSession = onClose;
      const closed = () => {
        onClose(socketError ?? new Error('TCP socket closed'));
      };
      const received = nodePacketListener(onPacket);
      decoder.on('packet', received);
      socket.on('close', closed);
      return () => {
        if (failSession === onClose) failSession = undefined;
        decoder.off('packet', received);
        socket.off('close', closed);
      };
    },
    async close(force) {
      if (!socket.destroyed) {
        if (force === true) socket.destroy();
        else socket.destroySoon();
      }
      await closed;
    },
  };

  const timer = setTimeout(() => {
    socket.destroy(new Error('TCP connection timed out'));
  }, options.timeoutMs ?? 3000);
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
    if (isAborted()) throw abortReason();
    return client;
  } catch (error) {
    await transport.close(true);
    if (isAborted()) throw abortReason();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
