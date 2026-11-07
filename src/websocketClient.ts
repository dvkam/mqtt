import { generate, parser, type IPublishPacket } from 'mqtt-packet';
import type { Agent } from 'node:http';
import type { SecureContextOptions } from 'node:tls';
import WebSocket from 'ws';
import { connectPortable, type PacketTransport } from './portable.js';

type WebSocketClientOptions = Parameters<typeof connectPortable<IPublishPacket>>[1] &
  Pick<SecureContextOptions, 'ca' | 'cert' | 'key'> & {
    url: string | URL;
    agent?: Agent;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    maxBufferedBytes?: number;
  };

export function createWebSocketClient(options: WebSocketClientOptions) {
  let connection: ReturnType<typeof connectPortable> | undefined;
  return {
    connect() {
      connection ??= openClient(options);
      return connection;
    },
  };
}

async function openClient(options: WebSocketClientOptions) {
  const { signal, timeoutMs = 3000, maxBufferedBytes = 1024 * 1024, agent, ca, cert, key, headers } = options;
  const abortReason = () => {
    const reason: unknown = signal?.reason;
    return reason instanceof Error ? reason : Object.assign(new Error('MQTT WebSocket aborted'), { name: 'AbortError' });
  };
  if (signal?.aborted) throw abortReason();
  if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
    throw new RangeError('WebSocket write budget must be a positive integer');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('MQTT WebSocket timeout must be positive and fit in a timer');
  }

  const socket = new WebSocket(options.url, 'mqtt', {
    agent,
    ca,
    cert,
    key,
    headers,
    handshakeTimeout: timeoutMs,
    perMessageDeflate: false,
  });
  socket.binaryType = 'nodebuffer';
  const codec = { protocolVersion: 5 };
  const decoder = parser(codec);
  const closed = new Promise<void>((resolve) => socket.once('close', resolve));
  let socketError: Error | undefined;
  socket.on('error', (error) => {
    socketError ??= error;
  });
  const terminate = (error: Error) => {
    socketError ??= error;
    socket.terminate();
  };
  const abort = () => terminate(abortReason());
  signal?.addEventListener('abort', abort, { once: true });
  socket.on('message', (data, binary) => {
    if (!binary || !Buffer.isBuffer(data)) {
      terminate(new Error('MQTT WebSocket requires binary messages'));
      return;
    }
    try {
      decoder.parse(data);
    } catch (error) {
      terminate(error instanceof Error ? error : new Error('MQTT WebSocket packet handler failed'));
    }
  });
  decoder.on('error', terminate);

  const transport: PacketTransport = {
    async send(packet) {
      if (socket.readyState !== WebSocket.OPEN) throw socketError ?? new Error('MQTT WebSocket closed');
      const bytes = generate(packet, codec);
      if (socket.bufferedAmount + bytes.byteLength > maxBufferedBytes) {
        throw new Error('WebSocket write budget exceeded');
      }
      await new Promise<void>((resolve, reject) => {
        socket.send(bytes, (error) => (error ? reject(error) : resolve()));
      });
    },
    listen(onPacket, onClose) {
      const failed = () => onClose(socketError ?? new Error('MQTT WebSocket closed'));
      decoder.on('packet', onPacket);
      socket.on('close', failed);
      return () => {
        decoder.off('packet', onPacket);
        socket.off('close', failed);
      };
    },
    async close(force) {
      if (socket.readyState === WebSocket.CLOSED) return;
      if (force) socket.terminate();
      else socket.close();
      const deadline = setTimeout(() => socket.terminate(), timeoutMs);
      try {
        await closed;
      } finally {
        clearTimeout(deadline);
      }
    },
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const opened = () => {
        socket.off('close', failed);
        resolve();
      };
      const failed = () => {
        socket.off('open', opened);
        reject(socketError ?? new Error('MQTT WebSocket closed before opening'));
      };
      socket.once('open', opened);
      socket.once('close', failed);
    });
    if (socket.protocol !== 'mqtt') throw new Error('MQTT WebSocket subprotocol was not negotiated');
    const client = await connectPortable(transport, options);
    if (signal?.aborted) throw abortReason();
    return client;
  } catch (error) {
    await transport.close(true);
    if (signal?.aborted) throw abortReason();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
