import { encodePacket, PacketDecoder, type BrokerPacket } from 'mqtt/codec';
import type { ByteTransport } from 'mqtt/portable';

/** Whether an MQTT topic filter matches a topic name. */
export function matches(filter: string, topic: string): boolean {
  const filterLevels = filter.split('/');
  const topicLevels = topic.split('/');
  for (let index = 0; index < filterLevels.length; index++) {
    const level = filterLevels[index];
    if (level === '#') return true;
    if (index >= topicLevels.length) return false;
    if (level !== '+' && level !== topicLevels[index]) return false;
  }
  return filterLevels.length === topicLevels.length;
}

/**
 * A broker that runs in the page. It accepts CONNECT, grants every SUBSCRIBE, acknowledges QoS 1 PUBLISH, answers
 * PINGREQ and sends each PUBLISH back to the subscriptions it matches. It refuses the topic `playground/refused` with
 * PUBACK reason 0x87, so the page can show a refusal.
 */
export function scriptedBroker(): ByteTransport {
  return {
    name: 'Scripted broker',
    async open(inbound) {
      const decoder = new PacketDecoder();
      const subscriptions = new Map<string, 0 | 1>();
      let nextId = 1;
      const reply = (packet: BrokerPacket): void => {
        // Deliver after the write that caused the reply has returned, as a socket would.
        queueMicrotask(() => {
          inbound.bytes(encodePacket(packet));
        });
      };
      return {
        bufferedBytes: 0,
        async write(bytes) {
          for (const packet of decoder.push(bytes)) {
            switch (packet.cmd) {
              case 'connect':
                reply({ cmd: 'connack', sessionPresent: false, reasonCode: 0, receiveMaximum: 16 });
                break;
              case 'subscribe':
                for (const topic of packet.topics) subscriptions.set(topic, packet.qos ?? 0);
                reply({ cmd: 'suback', messageId: packet.messageId, granted: packet.topics.map(() => packet.qos ?? 0) });
                break;
              case 'unsubscribe':
                for (const topic of packet.topics) subscriptions.delete(topic);
                reply({ cmd: 'unsuback', messageId: packet.messageId, granted: packet.topics.map(() => 0) });
                break;
              case 'pingreq':
                reply({ cmd: 'pingresp' });
                break;
              case 'publish': {
                const refused = packet.topic === 'playground/refused';
                if (packet.qos === 1) reply({ cmd: 'puback', messageId: packet.messageId, reasonCode: refused ? 0x87 : 0 });
                if (refused) break;
                for (const [filter, granted] of subscriptions) {
                  if (!matches(filter, packet.topic)) continue;
                  const qos = Math.min(granted, packet.qos ?? 0);
                  reply(
                    qos === 1
                      ? { cmd: 'publish', topic: packet.topic, payload: packet.payload, qos: 1, messageId: nextId++ % 65_535 || 1 }
                      : { cmd: 'publish', topic: packet.topic, payload: packet.payload },
                  );
                }
                break;
              }
              default:
                break;
            }
          }
        },
        async close() {},
      };
    },
  };
}
