import type { ByteInbound, ByteWriter, OpenContext } from './byteTransport.js';
import type { DiagnosticObserver } from './diagnostics.js';
import type { PublishMessage } from './messageProperties.js';
import type { NativeWriteLimits } from './nativeWriteBudget.js';
import type { PortableOptions } from './portable.js';
import { portablePlatform } from './portablePlatform.js';
import type { PublicationLimits } from './publicationAdmission.js';
import type { ClientFactory, ClientSession, QosOneMessage, QosTwoMessage, SessionEndObserver } from './session.js';
import type { SubscriptionLimits } from './subscriptionExchanges.js';
import { createByteClient, type SessionOptions } from './transportCore.js';
import { openMqttWebSocket } from './websocket.js';
import { resolveWebSocketMessageLimit } from './websocketLimits.js';
import { MqttError, ReceiveLimitError } from './mqttError.js';
import type { WillOptions } from './will.js';
import type { ReadonlyDeep } from './util/bytes.js';

export type BrowserMessage = PublishMessage;

export type BrowserQosOneMessage = QosOneMessage<BrowserMessage>;

/** A received QoS 2 PUBLISH in the browser, with a Uint8Array payload. */
export type BrowserQosTwoMessage = QosTwoMessage<BrowserMessage>;

export type BrowserSession = ClientSession;

export interface BrowserClientOptions extends PublicationLimits, SubscriptionLimits, NativeWriteLimits, SessionOptions {
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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The handler receives `message` as its own, and the application owns the message and may write its fields and its payload, which `browserFactory` in test/types/mutable-contracts.ts checks. A read-only parameter type in this declaration would be false.
  onMessage?: (message: BrowserMessage) => void;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The handler receives `message` as its own, and the application owns the message and may write its fields and its payload, which `browserFactory` in test/types/mutable-contracts.ts checks. A read-only parameter type in this declaration would be false.
  onQosOneMessage?: (message: BrowserQosOneMessage) => void | Promise<void>;
  /**
   * Receives each inbound QoS 2 publication once. The client sends PUBREC after the handler returns or its promise
   * fulfills. A handler that throws or rejects ends the session without PUBREC.
   */
  onQosTwoMessage?: NonNullable<PortableOptions['onQosTwoMessage']>;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `Readonly<BrowserClientOptions>` still fails the rule, because the options hold an AbortSignal and a Will with byte views. `ReadonlyDeep` would pass, but it is an internal type, and this signature is public, so it names only exported types. Exporting the deep type is left to the owner.
export function createBrowserClient(options: BrowserClientOptions): ClientFactory {
  return createByteClient(
    {
      name: 'WebSocket',
      supportsSharedSubscriptions: false,
      async open(inbound: Readonly<ByteInbound>, context: ReadonlyDeep<OpenContext>) {
        return openBrowserSocket(options, inbound, context);
      },
    },
    options,
    portablePlatform,
  );
}

/** Open a native WebSocket with the `mqtt` subprotocol and adapt it to the byte transport contract. */
async function openBrowserSocket(
  options: ReadonlyDeep<BrowserClientOptions>,
  inbound: Readonly<ByteInbound>,
  context: ReadonlyDeep<OpenContext>,
): Promise<ByteWriter> {
  const { timeoutMs } = context;
  const maxWebSocketMessageBytes = resolveWebSocketMessageLimit(context.maxPacketBytes, options.maxWebSocketMessageBytes);
  const socket = await openMqttWebSocket(options.url, { signal: context.signal, timeoutMs });
  let closeSeen = () => {};
  const closed = new Promise<void>((resolve) => {
    closeSeen = resolve;
  });
  const message = (event: Readonly<{ data: unknown }>) => {
    if (!(event.data instanceof ArrayBuffer)) {
      inbound.fail(new MqttError('ERR_MQTT_TRANSPORT', 'MQTT WebSocket requires binary messages'));
      return;
    }
    if (event.data.byteLength > maxWebSocketMessageBytes) {
      inbound.fail(new ReceiveLimitError('WebSocket receive message limit exceeded'));
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
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- Removing it would cost performance. `WebSocket.send` takes a writable view over an `ArrayBuffer` and rejects `ReadonlyBytes` (TS2345), so a read-only `bytes` would need a copy for every packet, and `WriterBytesAreWritable` in test/types/mutable-contracts.ts pins the writable type. The method is async without an await so that a closed socket rejects through the returned promise. Returning a promise from it costs about 49 bytes and 40 ns more for every packet (test/bench/promise-forwarding.ts, recorded in docs/measurements.md).
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
