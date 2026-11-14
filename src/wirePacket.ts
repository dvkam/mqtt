import type { Packet } from 'mqtt-packet';
import type { WirePacket } from './codec.js';

const payloadEncoder = new TextEncoder();

/** Translate a packet from the shared session into the portable codec's model. The session sends only client packets. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The session hands over mutable protocol packets and byte buffers. test/types/mutable-contracts.ts checks the transport declaration.
export function toWirePacket(packet: Packet): WirePacket {
  switch (packet.cmd) {
    case 'connect':
      return {
        cmd: 'connect',
        clientId: packet.clientId,
        cleanStart: packet.clean,
        keepAlive: packet.keepalive,
        username: packet.username,
        password: packet.password,
        receiveMaximum: packet.properties?.receiveMaximum,
      };
    case 'subscribe': {
      if (packet.messageId === undefined) throw new Error('SUBSCRIBE requires a packet identifier');
      const qos = packet.subscriptions[0]?.qos;
      if (qos === 2 || packet.subscriptions.some((subscription: Readonly<{ qos: number }>) => subscription.qos !== qos))
        throw new Error('Unsupported subscription options');
      return {
        cmd: 'subscribe',
        messageId: packet.messageId,
        topics: packet.subscriptions.map(({ topic }: Readonly<{ topic: string }>) => topic),
        qos,
      };
    }
    case 'unsubscribe':
      if (packet.messageId === undefined) throw new Error('UNSUBSCRIBE requires a packet identifier');
      return { cmd: 'unsubscribe', messageId: packet.messageId, topics: packet.unsubscriptions };
    case 'publish': {
      if (packet.qos === 2) throw new Error('Unsupported PUBLISH QoS');
      const fields = {
        cmd: 'publish' as const,
        topic: packet.topic,
        payload: typeof packet.payload === 'string' ? payloadEncoder.encode(packet.payload) : packet.payload,
        retain: packet.retain,
      };
      if (packet.qos !== 1) return fields;
      if (packet.messageId === undefined) throw new Error('QoS 1 PUBLISH requires a packet identifier');
      return { ...fields, qos: 1, messageId: packet.messageId, dup: packet.dup };
    }
    case 'puback':
      if (packet.messageId === undefined) throw new Error('PUBACK requires a packet identifier');
      return { cmd: 'puback', messageId: packet.messageId, reasonCode: packet.reasonCode ?? 0 };
    case 'disconnect':
      return { cmd: 'disconnect', reasonCode: packet.reasonCode };
    case 'pingreq':
      return { cmd: 'pingreq' };
    case 'auth':
    case 'connack':
    case 'pingresp':
    case 'pubcomp':
    case 'pubrec':
    case 'pubrel':
    case 'suback':
    case 'unsuback':
    default:
      throw new Error('Unsupported client operation');
  }
}
