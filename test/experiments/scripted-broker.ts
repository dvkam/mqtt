import type { ByteInbound, ByteTransport } from '../../src/byteTransport.js';
import { encodePacket, PacketDecoder, type BrokerPacket, type ClientPacket } from '../../src/codec.js';
import { MqttError } from '../../src/mqttError.js';
import type { ReadonlyBytes, ReadonlyDeep } from '../../src/util/bytes.js';

export interface Connection {
  readonly packets: ClientPacket[];
  /** Records each packet and answers none while true, as a connection that died without a close does. */
  silent: boolean;
  /** Sends a broker packet on this connection at once, even after it ended. */
  deliver(packet: ReadonlyDeep<BrokerPacket>): void;
  end(): void;
}

export interface Script {
  /** The CONNACK reason for the nth connection, starting at 1. Undefined withholds the CONNACK. */
  connack?: (connection: number) => number | undefined;
  /** The Session Present flag of the CONNACK for the nth connection, starting at 1. Defaults to false. */
  sessionPresent?: (connection: number) => boolean;
  /** Whether the write of a SUBSCRIBE rejects on the nth connection, starting at 1. The broker does not read that packet. */
  failSubscribeWrite?: (connection: number) => boolean;
  /** The SUBACK reason for a filter on the nth connection, starting at 1. Undefined withholds the SUBACK. Defaults to 0. */
  suback?: (topic: string, connection: number) => number | undefined;
  /** Whether to answer a QoS 1 PUBLISH with PUBACK. */
  puback?: boolean;
  /** The PUBACK reason. Defaults to 0. */
  pubackCode?: number;
  /** Sends the PUBACK for a QoS 1 PUBLISH and never settles the write of that PUBLISH. */
  holdPublishWrite?: boolean;
  /** Rejects every open with ECONNREFUSED. */
  refuse?: boolean;
  receiveMaximum?: number;
}

// A broker over the byte transport. It answers CONNECT, SUBSCRIBE and QoS 1 PUBLISH, and records every packet it reads.
export function broker(script: Readonly<Script> = {}) {
  const connections: Connection[] = [];
  const transport: ByteTransport = {
    name: 'Scripted broker',
    async open(inbound: Readonly<ByteInbound>) {
      const decoder = new PacketDecoder();
      const index = connections.length + 1;
      const deliver = (packet: ReadonlyDeep<BrokerPacket>): void => {
        inbound.bytes(encodePacket(packet));
      };
      const reply = (packet: ReadonlyDeep<BrokerPacket>): void => {
        // Deliver after the write that caused the reply has returned, as a socket would.
        queueMicrotask(() => {
          deliver(packet);
        });
      };
      const connection: Connection = {
        packets: [],
        silent: false,
        deliver,
        end() {
          inbound.end();
        },
      };
      connections.push(connection);
      if (script.refuse === true) throw new MqttError('ERR_MQTT_TRANSPORT', 'connect ECONNREFUSED');
      return Promise.resolve({
        bufferedBytes: 0,
        async write(bytes: ReadonlyBytes) {
          for (const packet of decoder.push(bytes)) {
            if (packet.cmd === 'connack' || packet.cmd === 'suback' || packet.cmd === 'unsuback' || packet.cmd === 'pingresp')
              continue;
            if (packet.cmd === 'subscribe' && script.failSubscribeWrite?.(index) === true)
              throw new MqttError('ERR_MQTT_TRANSPORT', 'write EPIPE');
            connection.packets.push(packet);
            if (connection.silent) continue;
            if (packet.cmd === 'connect') {
              const reasonCode = script.connack === undefined ? 0 : script.connack(index);
              if (reasonCode !== undefined)
                reply({
                  cmd: 'connack',
                  sessionPresent: script.sessionPresent?.(index) ?? false,
                  reasonCode,
                  ...(script.receiveMaximum === undefined ? {} : { receiveMaximum: script.receiveMaximum }),
                });
            } else if (packet.cmd === 'subscribe') {
              const [topic = ''] = packet.topics;
              const granted = script.suback === undefined ? 0 : script.suback(topic, index);
              if (granted !== undefined) reply({ cmd: 'suback', messageId: packet.messageId, granted: [granted] });
            } else if (packet.cmd === 'pingreq') {
              reply({ cmd: 'pingresp' });
            } else if (packet.cmd === 'publish' && packet.qos === 1 && script.puback !== false) {
              reply({ cmd: 'puback', messageId: packet.messageId, reasonCode: script.pubackCode ?? 0 });
              if (script.holdPublishWrite === true) await new Promise<void>(() => {});
            }
          }
        },
        async close() {},
      });
    },
  };
  /** The commands, and the filters of each SUBSCRIBE, that the broker read on the nth connection, counted from 0. */
  const received = (index: number): { commands: string[]; topics: string[] } => {
    const commands: string[] = [];
    const topics: string[] = [];
    for (const packet of connections[index]?.packets ?? []) {
      commands.push(packet.cmd);
      if (packet.cmd === 'subscribe') topics.push(...packet.topics);
    }
    return { commands, topics };
  };
  return { transport, connections, received };
}
