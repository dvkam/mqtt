import { ProtocolInputError } from './protocolInputError.js';
import { openBrowserTransport } from './browserTransport.js';
import { encodePacket, PacketDecoder, type UserProperty, type WirePacket } from './codec.js';
import { connectPortable, type PacketTransport } from './portable.js';
import type { ClientFactory, ClientSession, QosOneMessage } from './session.js';
import { resolveSubscriptionLimits, type SubscriptionLimits } from './subscriptionExchanges.js';
import { resolvePublicationLimits, type PublicationLimits } from './publicationAdmission.js';
import { resolveNativeWriteLimits, type NativeWriteLimits } from './nativeWriteBudget.js';

export interface BrowserMessage {
  cmd: 'publish';
  topic: string;
  payload: Uint8Array;
  qos: 0;
  dup: false;
  retain: boolean;
  userProperties?: readonly UserProperty[];
}

export type BrowserSession = ClientSession;

export interface BrowserClientOptions extends PublicationLimits, SubscriptionLimits, NativeWriteLimits {
  url: string | URL;
  clientId: string;
  username?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxPacketBytes?: number;
  maxWebSocketMessageBytes?: number;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser adapter preserves native signals and mutable packet payloads.
  onMessage?: (message: BrowserMessage) => void;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser message retains its mutable Uint8Array payload.
  onQosOneMessage?: (message: QosOneMessage<BrowserMessage>) => void | Promise<void>;
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
  const { timeoutMs, onQosOneMessage } = options;
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
      let packets: WirePacket[];
      try {
        packets = decoder.push(chunk);
      } catch (error) {
        if (!(error instanceof ProtocolInputError) || !protocolError) throw error;
        failure = error;
        protocolError(error);
        return;
      }
      const listener = deliver;
      for (const packet of packets) {
        if (deliver !== listener) break;
        switch (packet.cmd) {
          case 'connack': {
            const { receiveMaximum, maximumQoS } = packet;
            deliver?.({
              cmd: 'connack',
              sessionPresent: packet.sessionPresent,
              reasonCode: packet.reasonCode,
              properties: receiveMaximum === undefined && maximumQoS === undefined ? undefined : { receiveMaximum, maximumQoS },
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
          case 'connect':
          case 'pingreq':
          case 'subscribe':
          case 'unsubscribe':
          default:
            throw new Error('Unexpected MQTT packet from broker: ' + packet.cmd);
        }
      }
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
      let encoded: WirePacket;
      switch (packet.cmd) {
        case 'connect':
          encoded = {
            cmd: 'connect',
            clientId: packet.clientId,
            cleanStart: packet.clean,
            keepAlive: packet.keepalive,
            username: packet.username,
            password: packet.password,
            receiveMaximum: packet.properties?.receiveMaximum,
          };
          break;
        case 'subscribe': {
          if (packet.messageId === undefined) throw new Error('SUBSCRIBE requires a packet identifier');
          const qos = packet.subscriptions[0]?.qos;
          if (qos === 2 || packet.subscriptions.some((subscription: Readonly<{ qos: number }>) => subscription.qos !== qos))
            throw new Error('Unsupported browser subscription options');
          encoded = {
            cmd: 'subscribe',
            messageId: packet.messageId,
            topics: packet.subscriptions.map(({ topic }: Readonly<{ topic: string }>) => topic),
            qos,
          };
          break;
        }
        case 'unsubscribe':
          if (packet.messageId === undefined) throw new Error('UNSUBSCRIBE requires a packet identifier');
          encoded = {
            cmd: 'unsubscribe',
            messageId: packet.messageId,
            topics: packet.unsubscriptions,
          };
          break;
        case 'publish': {
          if (packet.qos === 2) throw new Error('Unsupported browser PUBLISH QoS');
          const fields = {
            cmd: 'publish' as const,
            topic: packet.topic,
            payload: typeof packet.payload === 'string' ? new TextEncoder().encode(packet.payload) : packet.payload,
            retain: packet.retain,
          };
          if (packet.qos === 1) {
            if (packet.messageId === undefined) throw new Error('QoS 1 PUBLISH requires a packet identifier');
            encoded = { ...fields, qos: 1, messageId: packet.messageId, dup: packet.dup };
          } else encoded = fields;
          break;
        }
        case 'puback':
          if (packet.messageId === undefined) throw new Error('PUBACK requires a packet identifier');
          encoded = {
            cmd: 'puback',
            messageId: packet.messageId,
            reasonCode: packet.reasonCode ?? 0,
          };
          break;
        case 'disconnect':
          encoded = { cmd: 'disconnect', reasonCode: packet.reasonCode };
          break;
        case 'pingreq':
          encoded = { cmd: packet.cmd };
          break;
        case 'auth':
        case 'connack':
        case 'pingresp':
        case 'pubcomp':
        case 'pubrec':
        case 'pubrel':
        case 'suback':
        case 'unsuback':
        default:
          throw new Error('Unsupported browser client operation');
      }
      bytes.send(encodePacket(encoded), packet.cmd === 'publish' ? 'publication' : 'control');
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
    onQosOneMessage,
  });
  if (options.signal?.aborted === true) {
    await transport.close(true);
    throw failure ?? new Error('MQTT WebSocket aborted');
  }
  return client;
}
