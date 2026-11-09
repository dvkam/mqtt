import { openBrowserTransport } from './browserTransport.js';
import { encodePacket, PacketDecoder, type UserProperty, type WirePacket } from './codec.js';
import { connectPortable, type PacketTransport } from './portable.js';
import type { ClientFactory, ClientSession } from './session.js';
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
  const timeoutMs = options.timeoutMs;
  const publicationLimits = resolvePublicationLimits(options);
  const subscriptionLimits = resolveSubscriptionLimits(options);
  const writeLimits = resolveNativeWriteLimits(options);
  const decoder = new PacketDecoder({ maxPacketBytes: options.maxPacketBytes });
  let deliver: Parameters<PacketTransport<BrowserMessage>['listen']>[0] | undefined;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser adapter preserves native signals and mutable packet payloads.
  let failed: ((reason: Error) => void) | undefined;
  let failure: Error | undefined;
  const bytes = await openBrowserTransport(options.url, {
    signal: options.signal,
    timeoutMs,
    ...writeLimits,
    maxWebSocketMessageBytes: options.maxWebSocketMessageBytes,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser adapter preserves native signals and mutable packet payloads.
    onBytes(chunk) {
      for (const packet of decoder.push(chunk)) {
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
            deliver?.({ cmd: 'puback', messageId: packet.messageId, reasonCode: packet.reasonCode });
            break;
          case 'suback':
            deliver?.({ cmd: 'suback', messageId: packet.messageId, granted: [...packet.granted] });
            break;
          case 'pingresp':
            deliver?.(packet);
            break;
          case 'disconnect':
            deliver?.({ cmd: 'disconnect', reasonCode: 0 });
            break;
          case 'publish':
            if (packet.qos === 1) throw new Error('Unsupported incoming MQTT QoS 1');
            deliver?.({
              cmd: 'publish',
              topic: packet.topic,
              payload: packet.payload,
              qos: 0,
              dup: false,
              retain: packet.retain ?? false,
              userProperties: packet.userProperties,
            });
            break;
          case 'connect':
          case 'pingreq':
          case 'subscribe':
          default:
            throw new Error('Unexpected MQTT packet from broker: ' + packet.cmd);
        }
      }
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The browser adapter preserves native signals and mutable packet payloads.
    onClose(reason, kind) {
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
          };
          break;
        case 'subscribe':
          if (packet.messageId === undefined) throw new Error('SUBSCRIBE requires a packet identifier');
          encoded = {
            cmd: 'subscribe',
            messageId: packet.messageId,
            topics: packet.subscriptions.map(({ topic }: Readonly<{ topic: string }>) => topic),
          };
          break;
        case 'publish':
          encoded = {
            cmd: 'publish',
            topic: packet.topic,
            payload: typeof packet.payload === 'string' ? new TextEncoder().encode(packet.payload) : packet.payload,
            retain: packet.retain,
          };
          break;
        case 'pingreq':
        case 'disconnect':
          encoded = { cmd: packet.cmd };
          break;
        case 'auth':
        case 'connack':
        case 'pingresp':
        case 'puback':
        case 'pubcomp':
        case 'pubrec':
        case 'pubrel':
        case 'suback':
        case 'unsuback':
        case 'unsubscribe':
        default:
          throw new Error('Unsupported browser client operation');
      }
      bytes.send(encodePacket(encoded), packet.cmd === 'publish' ? 'publication' : 'control');
    },
    listen(onPacket, onClose) {
      deliver = onPacket;
      failed = onClose;
      if (failure) onClose(failure);
      return () => {
        deliver = undefined;
        failed = undefined;
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
  });
  if (options.signal?.aborted === true) {
    await transport.close(true);
    throw failure ?? new Error('MQTT WebSocket aborted');
  }
  return client;
}
