import type { BytePlatform } from './bytePlatform.js';
import { publishMessage } from './messageProperties.js';
import type { ReceivedPacket } from './portable.js';
import { brokerPacketDirectionError, ProtocolInputError } from './protocolInputError.js';
import type { FramedPacket } from './wireCodec.js';

/**
 * The inbound rules: narrow the framer's packets to what the session receives. The session gets the public codec's broker
 * packets and flat messages whose byte fields `toBytes` views as `Bytes`. Every packet outside that profile ends here.
 */
export function inboundPacketListener<Bytes extends Uint8Array>(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The observer accepts mutable packets; deep readonly types would change the public payload contract.
  onPacket: (packet: ReceivedPacket<Bytes>) => void,
  receiveQosOne: boolean,
  toBytes: BytePlatform<Bytes>['bytes'],
) {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The listener forwards byte views of the framer's packet allocation.
  return (packet: FramedPacket): void => {
    switch (packet.cmd) {
      case 'publish':
        if (packet.qos === undefined || packet.qos === 0) onPacket(publishMessage(packet, toBytes));
        else if (!receiveQosOne) break;
        else if (packet.qos !== 1) throw new Error('Unsupported incoming MQTT PUBLISH');
        else onPacket({ ...publishMessage(packet, toBytes), qos: 1, messageId: packet.messageId, dup: packet.dup ?? false });
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
        // The framer rejects these on the first byte.
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
