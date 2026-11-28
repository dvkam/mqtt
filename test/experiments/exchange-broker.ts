import type { ByteInbound, ByteTransport } from '../../src/byteTransport.js';
import type { ReadonlyBytes } from '../../src/util/bytes.js';
import { encodePacket, PacketDecoder, type BrokerPacket, type ClientPacket } from '../../src/codec.js';

type Connack = Extract<BrokerPacket, { cmd: 'connack' }>;

/** What a script sees of a packet the broker read. */
export interface ReadPacket {
  readonly cmd: ClientPacket['cmd'];
  /** The topic of a PUBLISH. */
  readonly topic: string | undefined;
  /** The QoS of a PUBLISH, and 0 for any other packet. */
  readonly qos: 0 | 1 | 2;
  readonly messageId: number | undefined;
  /** The DUP flag of a PUBLISH. */
  readonly dup: boolean;
}

/** A packet the broker sends: an acknowledgment, or a PUBLISH whose payload is the UTF-8 bytes of `payload`. */
export type Delivery =
  | Readonly<{ cmd: 'puback' | 'pubrec' | 'pubrel' | 'pubcomp'; messageId: number; reasonCode: number }>
  | Readonly<{ cmd: 'publish'; topic: string; payload: string; qos?: 0 }>
  | Readonly<{ cmd: 'publish'; topic: string; payload: string; qos: 1 | 2; messageId: number; dup?: boolean }>;

export interface ExchangeConnection {
  /** Every packet the broker read, in order. */
  readonly packets: ClientPacket[];
  /** The bytes of every write after CONNECT, in order. */
  readonly frames: number[][];
  /** Sends a broker packet on this connection at once. */
  deliver(delivery: Delivery): void;
  /** Sends bytes as given, so a test can pin a wire vector. */
  deliverBytes(bytes: readonly number[]): void;
  end(): void;
}

export interface ExchangeScript {
  /** The CONNACK fields for the nth connection, starting at 1, besides the cmd and a reason code of 0. */
  connack?: (connection: number) => Partial<Omit<Connack, 'cmd'>>;
  /** Bytes the broker sends in answer to CONNECT before its CONNACK. */
  early?: readonly number[];
  /** The SUBACK reason for a filter. Defaults to the requested QoS. */
  suback?: (topic: string, requestedQos: number) => number;
  /**
   * The packets the broker sends in answer to a packet it read on the nth connection. Defaults to none. The answers to
   * CONNECT arrive in one chunk with the CONNACK, as the first packets of a resumed session can.
   */
  answer?: (packet: ReadPacket, connection: number) => readonly Delivery[] | undefined;
  /**
   * Whether the write of a packet stays pending until `releaseWrites`. The broker still reads and answers the packet.
   */
  hold?: (packet: ReadPacket, connection: number) => boolean;
  /** The writer's `bufferedBytes`. Defaults to 0. */
  buffered?: () => number;
  /** Deliver each answer from inside the write call that caused it, as an in-memory transport can. Defaults to false. */
  immediate?: boolean;
}

const encoder = new TextEncoder();

function encode(delivery: Delivery): Uint8Array {
  if (delivery.cmd !== 'publish') return encodePacket(delivery);
  const { topic } = delivery;
  const payload = encoder.encode(delivery.payload);
  if (delivery.qos === 1 || delivery.qos === 2) {
    const { qos, messageId, dup = false } = delivery;
    return encodePacket({ cmd: 'publish', topic, payload, qos, messageId, dup });
  }
  return encodePacket({ cmd: 'publish', topic, payload });
}

function describe({ cmd, topic, qos, messageId, dup }: ReadPacket): string {
  if (cmd === 'publish') return `publish ${String(topic)} qos ${String(qos)} id ${String(messageId)}${dup ? ' dup' : ''}`;
  return messageId === undefined || cmd === 'subscribe' || cmd === 'unsubscribe' ? cmd : `${cmd} ${String(messageId)}`;
}

/** Answers a QoS 1 PUBLISH with PUBACK, a QoS 2 PUBLISH with PUBREC and a PUBREL with PUBCOMP. */
export function acknowledge({ cmd, qos, messageId }: ReadPacket): readonly Delivery[] | undefined {
  if (messageId === undefined) return undefined;
  if (cmd === 'publish' && qos === 1) return [{ cmd: 'puback', messageId, reasonCode: 0 }];
  if (cmd === 'publish' && qos === 2) return [{ cmd: 'pubrec', messageId, reasonCode: 0 }];
  return cmd === 'pubrel' ? [{ cmd: 'pubcomp', messageId, reasonCode: 0 }] : undefined;
}

/**
 * A broker over the byte transport for the QoS 1 and QoS 2 exchange tests. It answers CONNECT, SUBSCRIBE and PINGREQ, and
 * the script decides every other answer. Each answer arrives one microtask after the write that caused it, unless the
 * script sets `immediate`.
 */
export function exchangeBroker(script: Readonly<ExchangeScript> = {}) {
  const connections: ExchangeConnection[] = [];
  const read: ReadPacket[][] = [];
  const held: (() => void)[] = [];
  const transport: ByteTransport = {
    name: 'Exchange broker',
    async open(inbound: Readonly<ByteInbound>) {
      const decoder = new PacketDecoder();
      const index = connections.length + 1;
      const seen: ReadPacket[] = [];
      const reply = (bytes: ArrayLike<number>): void => {
        if (script.immediate === true) inbound.bytes(Uint8Array.from(bytes));
        else
          queueMicrotask(() => {
            inbound.bytes(Uint8Array.from(bytes));
          });
      };
      const connection: ExchangeConnection = {
        packets: [],
        frames: [],
        deliver(delivery) {
          inbound.bytes(encode(delivery));
        },
        deliverBytes(bytes) {
          inbound.bytes(Uint8Array.from(bytes));
        },
        end() {
          inbound.end();
        },
      };
      connections.push(connection);
      read.push(seen);
      return Promise.resolve({
        get bufferedBytes() {
          return script.buffered?.() ?? 0;
        },
        async write(bytes: ReadonlyBytes) {
          if (bytes[0] !== 0x10) connection.frames.push([...bytes]);
          let pending = false;
          for (const packet of decoder.push(bytes)) {
            if (packet.cmd === 'connack' || packet.cmd === 'suback' || packet.cmd === 'unsuback' || packet.cmd === 'pingresp')
              continue;
            connection.packets.push(packet);
            const publish = packet.cmd === 'publish' ? packet : undefined;
            const summary: ReadPacket = {
              cmd: packet.cmd,
              topic: publish?.topic,
              qos: publish?.qos ?? 0,
              messageId: 'messageId' in packet ? packet.messageId : undefined,
              dup: publish?.dup === true,
            };
            seen.push(summary);
            const answers = script.answer?.(summary, index) ?? [];
            if (packet.cmd === 'connect') {
              const chunk: number[] = [...(script.early ?? [])];
              chunk.push(...encodePacket({ cmd: 'connack', sessionPresent: false, reasonCode: 0, ...script.connack?.(index) }));
              for (const answer of answers) chunk.push(...encode(answer));
              reply(chunk);
              continue;
            }
            if (packet.cmd === 'subscribe') {
              const [topic = ''] = packet.topics;
              const requested = packet.qos ?? 0;
              const granted = script.suback?.(topic, requested) ?? requested;
              reply(encodePacket({ cmd: 'suback', messageId: packet.messageId, granted: [granted] }));
            }
            if (packet.cmd === 'pingreq') reply(encodePacket({ cmd: 'pingresp' }));
            for (const answer of answers) reply(encode(answer));
            pending ||= script.hold?.(summary, index) === true;
          }
          if (pending)
            await new Promise<void>((resolve) => {
              held.push(resolve);
            });
        },
        async close() {},
      });
    },
  };
  /** The nth connection, counted from 0. */
  const connection = (index: number): ExchangeConnection => {
    const found = connections[index];
    if (found === undefined) throw new Error('The broker has no connection ' + String(index));
    return found;
  };
  /**
   * Each packet the broker read after CONNECT on the nth connection, counted from 0. A PUBLISH reads
   * `publish <topic> qos <QoS> id <Packet Identifier>`, with ` dup` when DUP is set. An acknowledgment reads as its command
   * and Packet Identifier, and any other packet as its command.
   */
  const sent = (index: number): string[] => (read[index] ?? []).slice(1).map(describe);
  /** Settle every write that `hold` kept pending. */
  const releaseWrites = (): void => {
    for (const release of held.splice(0)) release();
  };
  return { transport, connections, connection, sent, releaseWrites };
}

/** Let the client run every microtask that a packet or a settled write queued. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}
