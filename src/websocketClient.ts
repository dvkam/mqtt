import { generate } from 'mqtt-packet';
import type { Agent } from 'node:http';
import type { SecureContextOptions } from 'node:tls';
import WebSocket from 'ws';
import { connectPortable, type PacketTransport, type PortableOptions } from './portable.js';
import type { ClientFactory } from './session.js';
import type { NodeMessage } from './nodeMessage.js';
import { NodePacketInput } from './nodePacketInput.js';
import { resolveWebSocketMessageLimit } from './websocketLimits.js';

export interface WebSocketClientOptions extends PortableOptions<NodeMessage>, Pick<SecureContextOptions, 'ca' | 'cert' | 'key'> {
  url: string | URL;
  agent?: Agent;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxBufferedBytes?: number;
  maxWebSocketMessageBytes?: number;
  maxPacketBytes?: number;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The Node WebSocket adapter uses native agents, signals and shared packet buffers.
export function createWebSocketClient(options: Readonly<WebSocketClientOptions>): ClientFactory {
  let connection: ReturnType<typeof connectPortable> | undefined;
  return {
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    connect() {
      connection ??= openClient(options);
      return connection;
    },
  };
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The Node WebSocket adapter uses native agents, signals and shared packet buffers.
async function openClient(options: Readonly<WebSocketClientOptions>) {
  const { signal, timeoutMs = 3000, maxBufferedBytes = 1024 * 1024, agent, ca, cert, key, headers } = options;
  const isAborted = (): boolean => signal?.aborted === true;
  const abortReason = () => {
    const reason: unknown = signal?.reason;
    return reason instanceof Error ? reason : Object.assign(new Error('MQTT WebSocket aborted'), { name: 'AbortError' });
  };
  if (isAborted()) throw abortReason();
  if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
    throw new RangeError('WebSocket write budget must be a positive integer');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('MQTT WebSocket timeout must be positive and fit in a timer');
  }
  const maxWebSocketMessageBytes = resolveWebSocketMessageLimit(options.maxWebSocketMessageBytes);
  const input = new NodePacketInput(options.maxPacketBytes);

  const socket = new WebSocket(options.url, 'mqtt', {
    agent,
    ca,
    cert,
    key,
    headers,
    handshakeTimeout: timeoutMs,
    perMessageDeflate: false,
    maxPayload: maxWebSocketMessageBytes,
  });
  socket.binaryType = 'nodebuffer';
  const codec = { protocolVersion: 5 };
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      try {
        input.remoteEnd(new Error('MQTT WebSocket closed'));
      } finally {
        signal?.removeEventListener('abort', abort);
        resolve();
      }
    });
  });
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The Node WebSocket adapter uses native agents, signals and shared packet buffers.
  socket.on('error', (error) => {
    terminate(error);
  });
  const terminate = (error: Readonly<Error>) => {
    input.retire('error', error);
    signal?.removeEventListener('abort', abort);
    socket.terminate();
  };
  const abort = () => {
    input.retire('abort', input.reason ?? abortReason());
    socket.terminate();
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (isAborted()) abort();
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The Node WebSocket adapter uses native agents, signals and shared packet buffers.
  socket.on('message', (data, binary) => {
    if (!binary || !Buffer.isBuffer(data)) {
      terminate(new Error('MQTT WebSocket requires binary messages'));
      return;
    }
    const reason = input.push(data);
    if (reason) terminate(reason);
  });

  const transport: PacketTransport<NodeMessage> = {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The Node WebSocket adapter uses native agents, signals and shared packet buffers.
    async send(packet) {
      if (socket.readyState !== WebSocket.OPEN) throw input.reason ?? new Error('MQTT WebSocket closed');
      const bytes = generate(packet, codec);
      if (socket.bufferedAmount + bytes.byteLength > maxBufferedBytes) {
        throw new Error('WebSocket write budget exceeded');
      }
      await new Promise<void>((resolve, reject) => {
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The Node WebSocket adapter uses native agents, signals and shared packet buffers.
        socket.send(bytes, (error) => {
          error ? reject(error) : resolve();
        });
      });
    },
    listen(onPacket, onClose) {
      return input.listen(onPacket, onClose);
    },
    async close(force) {
      input.detachCore();
      if (socket.readyState === WebSocket.CLOSED) return;
      if (force === true) socket.terminate();
      else socket.close();
      const deadline = setTimeout(() => {
        socket.terminate();
      }, timeoutMs);
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
        reject(input.reason ?? new Error('MQTT WebSocket closed before opening'));
      };
      socket.once('open', opened);
      socket.once('close', failed);
    });
    if (socket.protocol !== 'mqtt') throw new Error('MQTT WebSocket subprotocol was not negotiated');
    const client = await connectPortable(transport, options);
    if (isAborted()) throw abortReason();
    return client;
  } catch (error) {
    await transport.close(true);
    if (isAborted()) throw abortReason();
    throw error;
  }
}
