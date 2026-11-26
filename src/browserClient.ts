import type { ByteInbound, ByteWriter, OpenContext } from './byteTransport.js';
import type { DiagnosticObserver } from './diagnostics.js';
import type { PublishMessage } from './messageProperties.js';
import type { NativeWriteLimits } from './nativeWriteBudget.js';
import { portablePlatform } from './portablePlatform.js';
import type { PublicationLimits } from './publicationAdmission.js';
import type { ClientFactory, ClientSession, QosOneMessage, SessionEndObserver } from './session.js';
import type { SubscriptionLimits } from './subscriptionExchanges.js';
import { createByteClient } from './transportCore.js';
import { openMqttWebSocket } from './websocket.js';
import { resolveWebSocketMessageLimit } from './websocketLimits.js';
import { MqttError } from './mqttError.js';
import type { WillOptions } from './will.js';

export type BrowserMessage = PublishMessage;

export type BrowserQosOneMessage = QosOneMessage<BrowserMessage>;

export type BrowserSession = ClientSession;

export interface BrowserClientOptions extends PublicationLimits, SubscriptionLimits, NativeWriteLimits {
  url: string | URL;
  clientId: string;
  username?: string;
  /** The CONNECT password, at most 65,535 bytes. A string is sent as its UTF-8 bytes. MQTT 5 allows it without a username. */
  password?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxPacketBytes?: number;
  maxWebSocketMessageBytes?: number;
  will?: WillOptions;
  onDiagnostic?: DiagnosticObserver;
  onSessionEnd?: SessionEndObserver;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser adapter preserves native signals and mutable packet payloads.
  onMessage?: (message: BrowserMessage) => void;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser message retains its mutable Uint8Array payload.
  onQosOneMessage?: (message: BrowserQosOneMessage) => void | Promise<void>;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser adapter preserves native signals and mutable packet payloads.
export function createBrowserClient(options: BrowserClientOptions): ClientFactory {
  return createByteClient(
    {
      name: 'WebSocket',
      supportsSharedSubscriptions: false,
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The opener keeps the inbound object and the native abort signal by identity.
      async open(inbound, context) {
        return openBrowserSocket(options, inbound, context);
      },
    },
    options,
    portablePlatform,
  );
}

/** Open a native WebSocket with the `mqtt` subprotocol and adapt it to the byte transport contract. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser adapter preserves native signals and mutable packet payloads.
async function openBrowserSocket(options: BrowserClientOptions, inbound: ByteInbound, context: OpenContext): Promise<ByteWriter> {
  const { timeoutMs } = context;
  const maxWebSocketMessageBytes = resolveWebSocketMessageLimit(context.maxPacketBytes, options.maxWebSocketMessageBytes);
  const socket = await openMqttWebSocket(options.url, { signal: context.signal, timeoutMs });
  let closeSeen = () => {};
  const closed = new Promise<void>((resolve) => {
    closeSeen = resolve;
  });
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser adapter preserves native signals and mutable packet payloads.
  const message = (event: MessageEvent) => {
    if (!(event.data instanceof ArrayBuffer)) {
      inbound.fail(new MqttError('ERR_MQTT_TRANSPORT', 'MQTT WebSocket requires binary messages'));
      return;
    }
    if (event.data.byteLength > maxWebSocketMessageBytes) {
      inbound.fail(new RangeError('WebSocket receive message limit exceeded'));
      return;
    }
    inbound.bytes(new Uint8Array(event.data));
  };
  const errored = () => {
    inbound.fail(new MqttError('ERR_MQTT_TRANSPORT', 'MQTT WebSocket failed'));
  };
  // Stop listening once the socket closes or the core closes it, so a late event reaches nothing.
  const detach = () => {
    socket.removeEventListener('message', message);
    socket.removeEventListener('error', errored);
  };
  socket.addEventListener('message', message);
  socket.addEventListener('error', errored);
  const nativeClosed = () => {
    socket.removeEventListener('close', nativeClosed);
    detach();
    try {
      inbound.end(new MqttError('ERR_MQTT_TRANSPORT', 'MQTT WebSocket closed'));
    } finally {
      closeSeen();
    }
  };
  socket.addEventListener('close', nativeClosed);

  return {
    get bufferedBytes() {
      return socket.bufferedAmount;
    },
    // oxlint-disable-next-line typescript/require-await, typescript/prefer-readonly-parameter-types -- A closed socket must reject through the writer's promise. The native socket keeps the encoded bytes.
    async write(bytes) {
      // send() on a closing socket drops the data without an error.
      if (socket.readyState !== WebSocket.OPEN) throw new MqttError('ERR_MQTT_TRANSPORT', 'MQTT WebSocket closed');
      socket.send(bytes);
    },
    async close(force) {
      detach();
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      if (socket.readyState === WebSocket.CLOSED) return;
      if (force) {
        socket.removeEventListener('close', nativeClosed);
        // A graceful close may still be waiting for the close event, which this listener no longer delivers.
        closeSeen();
        return;
      }
      // A browser cannot cut a WebSocket off. If the peer does not finish the close in time, stop waiting.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        socket.removeEventListener('close', nativeClosed);
      }
    },
  };
}
