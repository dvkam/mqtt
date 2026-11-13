import type { DiagnosticObserver } from './diagnostics.js';
import { brokerPacketDirectionError, isClientOnlyCommand, ProtocolInputError } from './protocolInputError.js';
import { openBrowserTransport } from './browserTransport.js';
import { encodePacket, PacketDecoder, type UserProperty } from './codec.js';
import { toWirePacket } from './wirePacket.js';
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

export interface BrowserMessage {
  cmd: 'publish';
  topic: string;
  payload: Uint8Array;
  qos: 0;
  dup: false;
  retain: boolean;
  userProperties?: readonly UserProperty[];
}

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
  let deliver: Parameters<PacketTransport<BrowserMessage>['listen']>[0] | undefined;
  let failed: ((reason: Readonly<Error>) => void) | undefined;
  let failure: Error | undefined;
  let protocolError: Parameters<PacketTransport<BrowserMessage>['listen']>[2];
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
        if (isClientOnlyCommand(packet.cmd)) {
          error = brokerPacketDirectionError(packet.cmd);
          break;
        }
        if (packet.cmd === 'connack' && (packet.authenticationMethod !== undefined || packet.authenticationData !== undefined)) {
          error = new ProtocolInputError('Unexpected MQTT authentication properties', 0x82);
          break;
        }
        switch (packet.cmd) {
          case 'connack': {
            const { receiveMaximum, maximumQoS, assignedClientIdentifier } = packet;
            deliver?.({
              cmd: 'connack',
              sessionPresent: packet.sessionPresent,
              reasonCode: packet.reasonCode,
              properties: { receiveMaximum, maximumQoS, assignedClientIdentifier },
            });
            break;
          }
          case 'puback':
            deliver?.({
              cmd: 'puback',
              messageId: packet.messageId,
              reasonCode: packet.reasonCode,
            });
            break;
          case 'suback':
          case 'unsuback':
            deliver?.({
              cmd: packet.cmd,
              messageId: packet.messageId,
              granted: [...packet.granted],
            });
            break;
          case 'pingresp':
            deliver?.(packet);
            break;
          case 'disconnect':
            deliver?.({ cmd: 'disconnect', reasonCode: packet.reasonCode ?? 0 });
            break;
          case 'publish': {
            const message = {
              cmd: 'publish' as const,
              topic: packet.topic,
              payload: packet.payload,
              retain: packet.retain ?? false,
              userProperties: packet.userProperties,
            };
            if (packet.qos === 1) {
              if (!onQosOneMessage) throw new Error('Unsupported incoming MQTT QoS 1');
              deliver?.({
                ...message,
                qos: 1,
                dup: packet.dup ?? false,
                messageId: packet.messageId,
              });
            } else deliver?.({ ...message, qos: 0, dup: false });
            break;
          }
          case 'auth':
          case 'pubrec':
          case 'pubrel':
          case 'pubcomp':
          default:
            throw new Error('Unexpected MQTT packet from broker');
        }
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
  const transport: PacketTransport<BrowserMessage> = {
    supportsSharedSubscriptions: false,
    // oxlint-disable-next-line typescript/require-await, typescript/prefer-readonly-parameter-types -- Encoding and admission failures must reject through the packet transport's promise API. The browser adapter preserves native signals and mutable packet payloads.
    async send(packet) {
      const frame = encodePacket(toWirePacket(packet));
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
