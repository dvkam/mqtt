import { createConnection, isIP } from 'node:net';
import tls, { type ConnectionOptions } from 'node:tls';
import type { ByteInbound, ByteWriter, OpenContext } from './byteTransport.js';
import type { ClientFactory } from './session.js';
import { nodePlatform } from './nodePlatform.js';
import { createByteClient, flushNativeWrites, type ByteClientOptions, type ByteWriterWithFlush } from './transportCore.js';
import { MqttError } from './mqttError.js';
import type { ReadonlyBytes, ReadonlyDeep } from './util/bytes.js';

export type TcpTlsOptions = Pick<ConnectionOptions, 'ca' | 'cert' | 'key' | 'servername'>;

export interface TcpClientOptions extends ByteClientOptions<Buffer> {
  host: string;
  port?: number;
  tls?: TcpTlsOptions;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `TcpClientOptions.tls` holds the caller's `ca`, `cert` and `key` as `Buffer` values. `ReadonlyDeep<TcpClientOptions>` turns them into `ReadonlyBytes`, which `tls.connect` in `openTcpSocket` rejects (TS2769), so the adapter would have to copy each TLS buffer before the handshake.
export function createTcpClient(options: Readonly<TcpClientOptions>): ClientFactory {
  return createByteClient(
    {
      name: 'TCP',
      async open(inbound: Readonly<ByteInbound>, context: ReadonlyDeep<OpenContext>) {
        return openTcpSocket(options, inbound, context);
      },
    },
    options,
    nodePlatform,
  );
}

/** Open a TCP or TLS socket and adapt it to the byte transport contract. */
async function openTcpSocket(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `TcpClientOptions.tls` holds the caller's `ca`, `cert` and `key` as `Buffer` values. `ReadonlyDeep<TcpClientOptions>` turns them into `ReadonlyBytes`, which `tls.connect` in `openTcpSocket` rejects (TS2769), so the adapter would have to copy each TLS buffer before the handshake.
  options: Readonly<TcpClientOptions>,
  inbound: Readonly<ByteInbound>,
  context: ReadonlyDeep<OpenContext>,
): Promise<ByteWriter> {
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
  socket.on('data', (chunk: string | Readonly<Buffer<Readonly<ArrayBufferLike>>>) => {
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
    async write(bytes: ReadonlyBytes) {
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
