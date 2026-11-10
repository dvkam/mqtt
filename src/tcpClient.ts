import { createConnection } from 'node:net';
import { generate } from 'mqtt-packet';
import { connectPortable, type PacketTransport, type PortableOptions } from './portable.js';
import type { ClientFactory } from './session.js';
import type { NodeMessage } from './nodeMessage.js';
import { NodePacketInput } from './nodePacketInput.js';
import { resolveSubscriptionLimits } from './subscriptionExchanges.js';
import { resolveTimeout } from './timeout.js';
import { resolvePublicationLimits } from './publicationAdmission.js';
import { allowsNativeWrite, resolveNativeWriteLimits, type NativeWriteLimits } from './nativeWriteBudget.js';

export interface TcpClientOptions extends PortableOptions<NodeMessage>, NativeWriteLimits {
  host: string;
  port?: number;
  signal?: AbortSignal;
  maxPacketBytes?: number;
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
  const { onDiagnostic, onSessionEnd, onQosOneMessage, signal } = options;
  const isAborted = (): boolean => signal?.aborted === true;
  const abortReason = () => {
    const reason: unknown = signal?.reason;
    return reason instanceof Error ? reason : Object.assign(new Error('TCP connection aborted'), { name: 'AbortError' });
  };
  if (isAborted()) throw abortReason();

  const timeoutMs = resolveTimeout(options.timeoutMs);
  const publicationLimits = resolvePublicationLimits(options);
  const subscriptionLimits = resolveSubscriptionLimits(options);
  const writeLimits = resolveNativeWriteLimits(options);

  const input = new NodePacketInput(options.maxPacketBytes);
  const socket = createConnection({ host: options.host, port: options.port ?? 1883 });
  const codec = { protocolVersion: 5 };
  socket.on('error', (error: Readonly<Error>) => {
    input.retire('error', error);
    signal?.removeEventListener('abort', abort);
  });
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      try {
        input.remoteEnd(new Error('TCP socket closed'));
      } finally {
        signal?.removeEventListener('abort', abort);
        resolve();
      }
    });
  });
  socket.once('end', () => {
    signal?.removeEventListener('abort', abort);
    const reason = input.remoteEnd(new Error('TCP socket closed'));
    socket.destroy(reason);
  });
  const abort = () => {
    input.retire('abort', input.reason ?? abortReason());
    socket.destroy(input.reason);
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (isAborted()) abort();
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The TCP adapter uses native signals, sockets and shared packet buffers.
  socket.on('data', (chunk) => {
    const reason = input.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    if (reason) {
      signal?.removeEventListener('abort', abort);
      socket.destroy(reason);
    }
  });

  const transport: PacketTransport<NodeMessage> = {
    // oxlint-disable-next-line typescript/promise-function-async, typescript/prefer-readonly-parameter-types -- Forward the existing promise without adding an async wrapper. The TCP adapter uses native signals, sockets and shared packet buffers.
    send(packet) {
      return new Promise((resolve, reject) => {
        const bytes = generate(packet, codec);
        if (
          !allowsNativeWrite(writeLimits, socket.writableLength, bytes.length, packet.cmd === 'publish' ? 'publication' : 'control')
        ) {
          reject(new Error('TCP write budget exceeded'));
          return;
        }
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The TCP adapter uses native signals, sockets and shared packet buffers.
        socket.write(bytes, (error) => {
          error ? reject(error) : resolve();
        });
      });
    },
    listen(onPacket, onClose, onProtocolError) {
      return input.listen(onPacket, onClose, onQosOneMessage !== undefined, onProtocolError);
    },
    async close(force) {
      input.detachCore();
      if (force === true) signal?.removeEventListener('abort', abort);
      if (!socket.destroyed) {
        if (force === true) socket.destroy();
        else socket.destroySoon();
      }
      await closed;
    },
  };

  const timer = setTimeout(() => {
    socket.destroy(new Error('TCP connection timed out'));
  }, timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      const connected = () => {
        socket.off('close', failed);
        resolve();
      };
      const failed = () => {
        socket.off('connect', connected);
        reject(input.reason ?? new Error('TCP socket closed before connecting'));
      };
      socket.once('connect', connected);
      socket.once('close', failed);
    });
    clearTimeout(timer);
    const client = await connectPortable(transport, {
      clientId: options.clientId,
      username: options.username,
      password: options.password,
      onMessage: options.onMessage,
      onDiagnostic,
      onSessionEnd,
      ...publicationLimits,
      ...subscriptionLimits,
      timeoutMs,
      onQosOneMessage,
    });
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
