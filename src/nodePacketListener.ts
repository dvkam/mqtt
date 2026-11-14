import type { IPublishPacket, Packet } from 'mqtt-packet';
import { messageProperties } from './messageProperties.js';
import type { FramedPacket } from './wireCodec.js';
import type { NodeMessage } from './nodeMessage.js';
import type { QosOneMessage } from './session.js';
import { nodeBytes, toSessionPacket } from './sessionPacket.js';

type ReceivedPacket = Exclude<Packet, IPublishPacket> | NodeMessage | QosOneMessage<NodeMessage>;
type FramedPublish = Extract<FramedPacket, { cmd: 'publish' }>;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Decoded packets carry mutable byte views that the message hands to the application.
function nodeMessage(packet: FramedPublish): NodeMessage {
  return {
    cmd: 'publish',
    topic: packet.topic,
    payload: nodeBytes(packet.payload),
    qos: 0,
    dup: false,
    retain: packet.retain ?? false,
    ...messageProperties(packet, nodeBytes),
  };
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The observer accepts mutable packets; deep readonly types would change the public payload contract.
export function nodePacketListener(onPacket: (packet: ReceivedPacket) => void, receiveQosOne = false) {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The listener forwards Buffer views of the decoder's packet allocation.
  return (packet: FramedPacket, length: number) => {
    if (packet.cmd !== 'publish') {
      onPacket(toSessionPacket(packet, length));
    } else if (packet.qos === undefined || packet.qos === 0) {
      onPacket(nodeMessage(packet));
    } else if (receiveQosOne) {
      if (packet.qos !== 1) throw new Error('Unsupported incoming MQTT PUBLISH');
      onPacket({ ...nodeMessage(packet), qos: 1, messageId: packet.messageId, dup: packet.dup ?? false });
    }
  };
}
