import type { Agent } from 'node:http';
import type { SecureContextOptions } from 'node:tls';
import WebSocket from 'ws';
import type { ByteInbound, ByteWriter, OpenContext } from './byteTransport.js';
import type { NativeWriteLimits } from './nativeWriteBudget.js';
import type { PortableOptions } from './portable.js';
import type { ClientFactory } from './session.js';
import { createByteClient } from './transportCore.js';
import { resolveWebSocketMessageLimit } from './websocketLimits.js';

export interface WebSocketClientOptions
  extends PortableOptions<Buffer>, NativeWriteLimits, Pick<SecureContextOptions, 'ca' | 'cert' | 'key'> {
  url: string | URL;
  agent?: Agent;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxWebSocketMessageBytes?: number;
  maxPacketBytes?: number;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The Node WebSocket adapter uses native agents, signals and shared packet buffers.
export function createWebSocketClient(options: Readonly<WebSocketClientOptions>): ClientFactory {
  return createByteClient(
    {
      name: 'WebSocket',
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The opener keeps the inbound object and the native abort signal by identity.
      async open(inbound, context) {
        return openSocket(options, inbound, context);
      },
    },
    options,
  );
}

type Options = Readonly<WebSocketClientOptions>;

/** Client frames are masked and compression is disabled, so a frame adds 6, 8 or 14 bytes. */
function frameOverhead(length: number): number {
  if (length < 126) return 6;
  return length < 65_536 ? 8 : 14;
}

/** Open a `ws` WebSocket with the `mqtt` subprotocol and adapt it to the byte transport contract. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The Node WebSocket adapter uses native agents, signals and shared packet buffers.
async function openSocket(options: Options, inbound: ByteInbound, context: OpenContext): Promise<ByteWriter> {
  const { agent, ca, cert, key, headers } = options;
  const { timeoutMs } = context;
  const maxWebSocketMessageBytes = resolveWebSocketMessageLimit(options.maxWebSocketMessageBytes);
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
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      try {
        inbound.end(new Error('MQTT WebSocket closed'));
      } finally {
        resolve();
      }
    });
  });
  socket.on('error', (error: Readonly<Error>) => {
    inbound.fail(error);
  });
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The Node WebSocket adapter uses native agents, signals and shared packet buffers.
  socket.on('message', (data, binary) => {
    if (!binary || !Buffer.isBuffer(data)) {
      inbound.fail(new Error('MQTT WebSocket requires binary messages'));
      return;
    }
    inbound.bytes(data);
  });

  const writer: ByteWriter = {
    get bufferedBytes() {
      return socket.bufferedAmount;
    },
    frameOverhead,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The socket keeps the encoded bytes by identity.
    async write(bytes) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('MQTT WebSocket closed');
      return new Promise((resolve, reject) => {
        socket.send(bytes, (error?: Readonly<Error> | null) => {
          error ? reject(error) : resolve();
        });
      });
    },
    async close(force) {
      if (socket.readyState === WebSocket.CLOSED) return;
      if (force) socket.terminate();
      else socket.close();
      // A peer that does not answer the closing handshake is cut off after the operation timeout.
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

  const cancel = () => {
    socket.terminate();
  };
  context.signal.addEventListener('abort', cancel, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const opened = () => {
        socket.off('close', failed);
        resolve();
      };
      const failed = () => {
        socket.off('open', opened);
        reject(new Error('MQTT WebSocket closed before opening'));
      };
      socket.once('open', opened);
      socket.once('close', failed);
    });
  } finally {
    context.signal.removeEventListener('abort', cancel);
  }
  // ws refuses a handshake response without the requested subprotocol, so an open socket speaks mqtt.
  return writer;
}
