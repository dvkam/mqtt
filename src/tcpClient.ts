import { createConnection, isIP } from 'node:net';
import tls, { type ConnectionOptions } from 'node:tls';
import type { ByteInbound, ByteWriter, OpenContext } from './byteTransport.js';
import type { ClientFactory } from './session.js';
import { nodePlatform } from './nodePlatform.js';
import { createByteClient, flushNativeWrites, type ByteClientOptions, type ByteWriterWithFlush } from './transportCore.js';
import { MqttError } from './mqttError.js';

export type TcpTlsOptions = Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'servername'>;

export interface TcpClientOptions extends ByteClientOptions<Buffer> {
  host: string;
  port?: number;
  tls?: TcpTlsOptions;
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
        inbound.end(new MqttError('ERR_MQTT_TRANSPORT', connectionLabel + ' socket closed'));
      } finally {
        resolve();
      }
    });
  });
  socket.once('end', () => {
    inbound.end(new MqttError('ERR_MQTT_TRANSPORT', connectionLabel + ' socket closed'));
  });
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The TCP adapter uses native signals, sockets and shared packet buffers.
  socket.on('data', (chunk) => {
    inbound.bytes(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  });

  let writeBatch: 'idle' | 'first' | 'corked' = 'idle';
  const flushPending = () => {
    if (writeBatch !== 'corked') return;
    writeBatch = 'first';
    socket.uncork();
  };
  const writer: ByteWriterWithFlush = {
    ...(tlsOptions === undefined ? { [flushNativeWrites]: flushPending } : {}),
    get bufferedBytes() {
      return socket.writableLength;
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The socket keeps the encoded bytes by identity.
    async write(bytes) {
      // Node's TLS writer already coalesces these writes before they reach the socket.
      if (tlsOptions === undefined && writeBatch === 'idle') {
        writeBatch = 'first';
        // Keep the first packet on the immediate write path. Buffer only a synchronous burst's tail.
        queueMicrotask(() => {
          flushPending();
          writeBatch = 'idle';
        });
      } else if (writeBatch === 'first') {
        writeBatch = 'corked';
        socket.cork();
      }
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
    socket.destroy(new MqttError('ERR_MQTT_TIMEOUT', connectionLabel + ' connection timed out'));
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
      reject(new MqttError('ERR_MQTT_TRANSPORT', connectionLabel + ' socket closed before connecting'));
    };
    socket.once(connectionEvent, connected);
    socket.once('close', failed);
  });
}
