import { openBrowserTransport } from './browserTransport.js';
import { encodePacket, PacketDecoder, type UserProperty, type WirePacket } from './codec.js';
import { connectPortable, type PacketTransport } from './portable.js';

export interface BrowserMessage {
  cmd: 'publish';
  topic: string;
  payload: Uint8Array;
  qos: 0;
  dup: false;
  retain: boolean;
  userProperties?: readonly UserProperty[];
}

export interface BrowserSession {
  subscribe(topic: string): Promise<void>;
  publish(topic: string, payload: string): Promise<void>;
  ping(): Promise<void>;
  disconnect(): Promise<void>;
}

interface BrowserClientOptions {
  url: string | URL;
  clientId: string;
  username?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBufferedBytes?: number;
  maxPacketBytes?: number;
  onMessage?: (message: BrowserMessage) => void;
}

export function createBrowserClient(options: BrowserClientOptions): { connect(): Promise<BrowserSession> } {
  let connection: Promise<BrowserSession> | undefined;
  return {
    connect() {
      connection ??= openClient(options);
      return connection;
    },
  };
}

async function openClient(options: BrowserClientOptions): Promise<BrowserSession> {
  const decoder = new PacketDecoder({ maxPacketBytes: options.maxPacketBytes });
  let deliver: Parameters<PacketTransport<BrowserMessage>['listen']>[0] | undefined;
  let failed: ((reason: Error) => void) | undefined;
  let failure: Error | undefined;
  const bytes = await openBrowserTransport(options.url, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBufferedBytes: options.maxBufferedBytes,
    onBytes(chunk) {
      for (const packet of decoder.push(chunk)) {
        switch (packet.cmd) {
          case 'connack':
            deliver?.({ cmd: 'connack', sessionPresent: packet.sessionPresent, reasonCode: packet.reasonCode });
            break;
          case 'suback':
            deliver?.({ cmd: 'suback', messageId: packet.messageId, granted: [...packet.granted] });
            break;
          case 'pingresp':
            deliver?.(packet);
            break;
          case 'publish':
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
          default:
            throw new Error('Unexpected MQTT packet from broker: ' + packet.cmd);
        }
      }
    },
    onClose(reason) {
      failure ??= reason;
      failed?.(failure);
    },
  });
  const transport: PacketTransport<BrowserMessage> = {
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
          encoded = { cmd: 'subscribe', messageId: packet.messageId, topics: packet.subscriptions.map(({ topic }) => topic) };
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
        default:
          throw new Error('Unsupported browser client operation');
      }
      bytes.send(encodePacket(encoded));
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
      if (force) {
        // Local retirement has already reported the operation's terminal reason.
        void closing.catch(() => {});
        return;
      }
      await closing;
    },
  };
  const client = await connectPortable(transport, {
    clientId: options.clientId,
    username: options.username,
    timeoutMs: options.timeoutMs,
    onMessage: options.onMessage,
  });
  if (options.signal?.aborted) {
    await transport.close(true);
    throw failure ?? new Error('MQTT WebSocket aborted');
  }
  return client;
}
