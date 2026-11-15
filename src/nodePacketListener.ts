import type { IPublishPacket, Packet } from 'mqtt-packet';
import { publishMessage } from './messageProperties.js';
import type { FramedPacket } from './wireCodec.js';
import { nodeBytes, type NodeMessage } from './nodeMessage.js';
import type { QosOneMessage } from './session.js';
import { toSessionPacket } from './sessionPacket.js';

type ReceivedPacket = Exclude<Packet, IPublishPacket> | NodeMessage | QosOneMessage<NodeMessage>;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The observer accepts mutable packets; deep readonly types would change the public payload contract.
export function nodePacketListener(onPacket: (packet: ReceivedPacket) => void, receiveQosOne = false) {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The listener forwards Buffer views of the decoder's packet allocation.
  return (packet: FramedPacket, length: number) => {
    if (packet.cmd !== 'publish') {
      onPacket(toSessionPacket(packet, length));
    } else if (packet.qos === undefined || packet.qos === 0) {
      onPacket(publishMessage(packet, nodeBytes));
    } else if (receiveQosOne) {
      if (packet.qos !== 1) throw new Error('Unsupported incoming MQTT PUBLISH');
      onPacket({ ...publishMessage(packet, nodeBytes), qos: 1, messageId: packet.messageId, dup: packet.dup ?? false });
    }
  };
}
