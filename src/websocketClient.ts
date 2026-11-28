import type { Agent } from 'node:http';
import type { SecureContextOptions } from 'node:tls';
import WebSocket from 'ws';
import type { ByteInbound, ByteWriter, OpenContext } from './byteTransport.js';
import type { ClientFactory } from './session.js';
import { nodePlatform } from './nodePlatform.js';
import { createByteClient, type ByteClientOptions } from './transportCore.js';
import { resolveWebSocketMessageLimit } from './websocketLimits.js';
import { MqttError } from './mqttError.js';
import type { RawData } from 'ws';
import type { ReadonlyBytes, ReadonlyDeep } from './util/bytes.js';

export interface WebSocketClientOptions extends ByteClientOptions<Buffer>, Pick<SecureContextOptions, 'ca' | 'cert' | 'key'> {
  url: string | URL;
  agent?: Agent;
  headers?: Record<string, string>;
  maxWebSocketMessageBytes?: number;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `WebSocketClientOptions` holds the caller's `agent` and its `ca`, `cert` and `key` buffers. `ReadonlyDeep<WebSocketClientOptions>` turns the agent into a read-only structure and the buffers into `ReadonlyBytes`, which the `ws` constructor in `openSocket` rejects (TS2322), so the adapter would have to copy each of them before it connects.
export function createWebSocketClient(options: Readonly<WebSocketClientOptions>): ClientFactory {
  return createByteClient(
    {
      name: 'WebSocket',
      async open(inbound: Readonly<ByteInbound>, context: ReadonlyDeep<OpenContext>) {
        return openSocket(options, inbound, context);
      },
    },
    options,
    nodePlatform,
  );
}

type Options = Readonly<WebSocketClientOptions>;

/** Client frames are masked and compression is disabled, so a frame adds 6, 8 or 14 bytes. */
function frameOverhead(length: number): number {
  if (length < 126) return 6;
  return length < 65_536 ? 8 : 14;
}

/** Open a `ws` WebSocket with the `mqtt` subprotocol and adapt it to the byte transport contract. */
async function openSocket(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `WebSocketClientOptions` holds the caller's `agent` and its `ca`, `cert` and `key` buffers. `ReadonlyDeep<WebSocketClientOptions>` turns the agent into a read-only structure and the buffers into `ReadonlyBytes`, which the `ws` constructor in `openSocket` rejects (TS2322), so the adapter would have to copy each of them before it connects.
  options: Options,
  inbound: Readonly<ByteInbound>,
  context: ReadonlyDeep<OpenContext>,
): Promise<ByteWriter> {
  const { agent, ca, cert, key, headers } = options;
  const { timeoutMs } = context;
  const maxWebSocketMessageBytes = resolveWebSocketMessageLimit(context.maxPacketBytes, options.maxWebSocketMessageBytes);
  const { url } = options;
  context.signal.throwIfAborted();
  const socket = new WebSocket(url, 'mqtt', {
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
        inbound.end(new MqttError('ERR_MQTT_TRANSPORT', 'MQTT WebSocket closed'));
      } finally {
        resolve();
      }
    });
  });
  socket.on('error', (error: Readonly<Error>) => {
    inbound.fail(error);
  });
  socket.on('message', (data: ReadonlyDeep<RawData>, binary) => {
    if (!binary || !Buffer.isBuffer(data)) {
      inbound.fail(new MqttError('ERR_MQTT_TRANSPORT', 'MQTT WebSocket requires binary messages'));
      return;
    }
    inbound.bytes(data);
  });

  const writer: ByteWriter = {
    get bufferedBytes() {
      return socket.bufferedAmount;
    },
    frameOverhead,
    async write(bytes: ReadonlyBytes) {
      if (socket.readyState !== WebSocket.OPEN) throw new MqttError('ERR_MQTT_TRANSPORT', 'MQTT WebSocket closed');
      return new Promise((resolve, reject) => {
        socket.send(bytes, (error?: Readonly<Error> | null) => {
          if (error) reject(error);
          else resolve();
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
        reject(new MqttError('ERR_MQTT_TRANSPORT', 'MQTT WebSocket closed before opening'));
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
