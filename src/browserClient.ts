import type { DiagnosticObserver } from './diagnostics.js';
import { brokerPacketDirectionError, ProtocolInputError } from './protocolInputError.js';
import { openBrowserTransport } from './browserTransport.js';
import { encodePacket, isClientOnlyPacket, PacketDecoder } from './wireCodec.js';
import { publishMessage, type PublishMessage } from './messageProperties.js';
import { connectPortable, type PacketTransport } from './portable.js';
import type { ClientFactory, ClientSession, QosOneMessage, SessionEndObserver } from './session.js';
import { resolveSubscriptionLimits, type SubscriptionLimits } from './subscriptionExchanges.js';
import { resolvePublicationLimits, type PublicationLimits } from './publicationAdmission.js';
import {
  recordNativeBudgetFailure,
  resolveNativeWriteLimits,
  takeNativeBudgetFailure,
  type NativeWriteLimits,
} from './nativeWriteBudget.js';

export type BrowserMessage = PublishMessage;

export type BrowserQosOneMessage = QosOneMessage<BrowserMessage>;

export type BrowserSession = ClientSession;

export interface BrowserClientOptions extends PublicationLimits, SubscriptionLimits, NativeWriteLimits {
  url: string | URL;
  clientId: string;
  username?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxPacketBytes?: number;
  maxWebSocketMessageBytes?: number;
  onDiagnostic?: DiagnosticObserver;
  onSessionEnd?: SessionEndObserver;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser adapter preserves native signals and mutable packet payloads.
  onMessage?: (message: BrowserMessage) => void;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser message retains its mutable Uint8Array payload.
  onQosOneMessage?: (message: BrowserQosOneMessage) => void | Promise<void>;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Browser messages keep the decoder's mutable byte views.
function browserBytes(value: Uint8Array): Uint8Array {
  return value;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser adapter preserves native signals and mutable packet payloads.
export function createBrowserClient(options: BrowserClientOptions): ClientFactory {
  let connection: Promise<BrowserSession> | undefined;
  return {
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    connect() {
      connection ??= openClient(options);
      return connection;
    },
  };
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser adapter preserves native signals and mutable packet payloads.
async function openClient(options: BrowserClientOptions): Promise<BrowserSession> {
  const { timeoutMs, onQosOneMessage, onDiagnostic, onSessionEnd } = options;
  const publicationLimits = resolvePublicationLimits(options);
  const subscriptionLimits = resolveSubscriptionLimits(options);
  const writeLimits = resolveNativeWriteLimits(options);
  const decoder = new PacketDecoder({ maxPacketBytes: options.maxPacketBytes });
  let deliver: Parameters<PacketTransport['listen']>[0] | undefined;
  let failed: ((reason: Readonly<Error>) => void) | undefined;
  let failure: Error | undefined;
  let protocolError: Parameters<PacketTransport['listen']>[2];
  const bytes = await openBrowserTransport(options.url, {
    signal: options.signal,
    timeoutMs,
    ...writeLimits,
    maxWebSocketMessageBytes: options.maxWebSocketMessageBytes,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser adapter preserves native signals and mutable packet payloads.
    onBytes(chunk) {
      if (failure) return;
      const batch = decoder.pushBatch(chunk);
      const rejected = !Array.isArray(batch);
      let error = rejected ? batch.error : undefined;
      const packets = rejected ? batch.packets : batch;
      const listener = deliver;
      for (const packet of packets) {
        if (deliver !== listener) return;
        if (isClientOnlyPacket(packet)) {
          error = brokerPacketDirectionError(packet.cmd);
          break;
        }
        if (packet.cmd !== 'publish') deliver?.(packet);
        else if (packet.qos !== 1) deliver?.(publishMessage(packet, browserBytes));
        else if (!onQosOneMessage) throw new Error('Unsupported incoming MQTT QoS 1');
        else deliver?.({ ...publishMessage(packet, browserBytes), qos: 1, messageId: packet.messageId, dup: packet.dup ?? false });
      }
      if (deliver !== listener || !error) return;
      if (!(error instanceof ProtocolInputError) || !protocolError) throw error;
      failure = error;
      protocolError(error);
    },
    onClose(reason: Readonly<Error>, kind) {
      let terminalReason = reason;
      try {
        decoder.finish();
      } catch (error) {
        if (kind === 'remote') terminalReason = error instanceof Error ? error : new Error('MQTT decoder completion failed');
      }
      failure ??= terminalReason;
      failed?.(failure);
    },
  });
  const transport: PacketTransport = {
    supportsSharedSubscriptions: false,
    // oxlint-disable-next-line typescript/require-await, typescript/prefer-readonly-parameter-types -- Encoding and admission failures must reject through the packet transport's promise API. The browser adapter preserves native signals and mutable packet payloads.
    async send(packet) {
      const frame = encodePacket(packet);
      try {
        bytes.send(frame, packet.cmd === 'publish' ? 'publication' : 'control');
      } catch (reason) {
        const rejected = takeNativeBudgetFailure(frame, reason);
        if (rejected !== undefined) recordNativeBudgetFailure(packet, rejected);
        throw reason;
      }
    },
    listen(onPacket, onClose, onProtocolError) {
      deliver = onPacket;
      protocolError = onProtocolError;
      failed = onClose;
      if (failure) onClose(failure);
      return () => {
        deliver = undefined;
        failed = undefined;
        protocolError = undefined;
      };
    },
    async close(force) {
      const closing = bytes.close();
      if (force === true) {
        // Local retirement has already reported the operation's terminal reason.
        void closing.catch(() => {});
        return;
      }
      await closing;
    },
  };
  const client = await connectPortable(transport, {
    ...publicationLimits,
    ...subscriptionLimits,
    clientId: options.clientId,
    username: options.username,
    timeoutMs,
    onMessage: options.onMessage,
    onDiagnostic,
    onSessionEnd,
    onQosOneMessage,
  });
  if (options.signal?.aborted === true) {
    await transport.close(true);
    throw failure ?? new Error('MQTT WebSocket aborted');
  }
  return client;
}
