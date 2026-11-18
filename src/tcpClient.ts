import { createConnection, isIP } from 'node:net';
import tls, { type ConnectionOptions } from 'node:tls';
import type { ByteInbound, ByteWriter, OpenContext } from './byteTransport.js';
import type { NativeWriteLimits } from './nativeWriteBudget.js';
import type { PortableOptions } from './portable.js';
import type { ClientFactory } from './session.js';
import { nodePlatform } from './nodePlatform.js';
import { createByteClient } from './transportCore.js';

export type TcpTlsOptions = Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'servername'>;

export interface TcpClientOptions extends PortableOptions<Buffer>, NativeWriteLimits {
  host: string;
  port?: number;
  tls?: TcpTlsOptions;
  signal?: AbortSignal;
  maxPacketBytes?: number;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The TCP adapter uses native signals, sockets and shared packet buffers.
export function createTcpClient(options: Readonly<TcpClientOptions>): ClientFactory {
  return createByteClient(
    {
      name: 'TCP',
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The opener keeps the inbound object and the native abort signal by identity.
      async open(inbound, context) {
        return openTcpSocket(options, inbound, context);
      },
    },
    options,
    nodePlatform,
  );
}

/** Open a TCP or TLS socket and adapt it to the byte transport contract. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The TCP adapter uses native signals, sockets and shared packet buffers.
async function openTcpSocket(options: Readonly<TcpClientOptions>, inbound: ByteInbound, context: OpenContext): Promise<ByteWriter> {
  const tlsOptions = options.tls;
  const connectionLabel = tlsOptions === undefined ? 'TCP' : 'TLS';
  const connectionEvent = tlsOptions === undefined ? 'connect' : 'secureConnect';
  const socket =
    tlsOptions === undefined
      ? createConnection({ host: options.host, port: options.port ?? 1883 })
      : tls.connect({
          ca: tlsOptions.ca,
          cert: tlsOptions.cert,
          key: tlsOptions.key,
          rejectUnauthorized: true,
          host: options.host,
          port: options.port ?? 8883,
          servername: tlsOptions.servername ?? (isIP(options.host) === 0 ? options.host : undefined),
        });
  socket.setNoDelay(true);
  socket.on('error', (error: Readonly<Error>) => {
    inbound.fail(error);
  });
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      try {
        inbound.end(new Error(connectionLabel + ' socket closed'));
      } finally {
        resolve();
      }
    });
  });
  socket.once('end', () => {
    inbound.end(new Error(connectionLabel + ' socket closed'));
  });
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The TCP adapter uses native signals, sockets and shared packet buffers.
  socket.on('data', (chunk) => {
    inbound.bytes(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  });

  const writer: ByteWriter = {
    get bufferedBytes() {
      return socket.writableLength;
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The socket keeps the encoded bytes by identity.
    async write(bytes) {
      return new Promise((resolve, reject) => {
        socket.write(bytes, (error?: Readonly<Error> | null) => {
          error ? reject(error) : resolve();
        });
      });
    },
    async close(force) {
      if (!socket.destroyed) {
        if (force) socket.destroy();
        else socket.destroySoon();
      }
      await closed;
    },
  };

  const cancel = () => {
    const reason: unknown = context.signal.reason;
    socket.destroy(reason instanceof Error ? reason : undefined);
  };
  context.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    socket.destroy(new Error(connectionLabel + ' connection timed out'));
  }, context.timeoutMs);
  return new Promise<ByteWriter>((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', cancel);
    };
    const connected = () => {
      socket.off('close', failed);
      settle();
      resolve(writer);
    };
    const failed = () => {
      socket.off(connectionEvent, connected);
      settle();
      reject(new Error(connectionLabel + ' socket closed before connecting'));
    };
    socket.once(connectionEvent, connected);
    socket.once('close', failed);
  });
}
