import { publishMessage } from './messageProperties.js';
import { nodeBytes } from './nodeMessage.js';
import type { ReceivedPacket } from './portable.js';
import { brokerPacketDirectionError, ProtocolInputError } from './protocolInputError.js';
import type { FramedPacket } from './wireCodec.js';

/**
 * Narrow the Node decoder's extended profile to what the session receives. The session gets the public codec's broker
 * packets and flat messages with Buffer bytes. Every packet outside that profile ends here.
 */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The observer accepts mutable packets; deep readonly types would change the public payload contract.
export function nodePacketListener(onPacket: (packet: ReceivedPacket<Buffer>) => void, receiveQosOne = false) {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The listener forwards Buffer views of the decoder's packet allocation.
  return (packet: FramedPacket): void => {
    switch (packet.cmd) {
      case 'publish':
        if (packet.qos === undefined || packet.qos === 0) onPacket(publishMessage(packet, nodeBytes));
        else if (!receiveQosOne) break;
        else if (packet.qos !== 1) throw new Error('Unsupported incoming MQTT PUBLISH');
        else onPacket({ ...publishMessage(packet, nodeBytes), qos: 1, messageId: packet.messageId, dup: packet.dup ?? false });
        break;
      case 'auth':
        throw new ProtocolInputError('Unexpected MQTT AUTH', 0x82);
      case 'pubrec':
      case 'pubrel':
      case 'pubcomp':
        // QoS 2 is #13. The session ignored these packets before they stopped reaching it.
        break;
      case 'connect':
      case 'subscribe':
      case 'unsubscribe':
      case 'pingreq':
        // NodePacketDecoder rejects these on the first byte.
        throw brokerPacketDirectionError(packet.cmd);
      case 'connack':
      case 'puback':
      case 'suback':
      case 'unsuback':
      case 'pingresp':
      case 'disconnect':
        onPacket(packet);
    }
  };
}
