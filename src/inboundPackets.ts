import type { BytePlatform } from './bytePlatform.js';
import { publishMessage } from './messageProperties.js';
import type { ReceivedPacket } from './portable.js';
import { brokerPacketDirectionError, ProtocolInputError } from './protocolInputError.js';
import type { FramedPacket } from './wireCodec.js';

/**
 * The inbound rules: narrow the framer's packets to what the session receives. The session gets the public codec's broker
 * packets and flat messages whose byte fields `toBytes` views as `Bytes`. Every packet outside that profile ends here. A
 * PUBLISH of every QoS goes on, because the session decides which QoS it acknowledges.
 */
export function inboundPacketListener<Bytes extends Uint8Array>(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The observer accepts mutable packets; deep readonly types would change the public payload contract.
  onPacket: (packet: ReceivedPacket<Bytes>) => void,
  toBytes: BytePlatform<Bytes>['bytes'],
) {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The listener forwards byte views of the framer's packet allocation.
  return (packet: FramedPacket): void => {
    switch (packet.cmd) {
      case 'publish':
        if (packet.qos === 1 || packet.qos === 2) {
          const { messageId, dup = false } = packet;
          onPacket(
            packet.qos === 1
              ? { ...publishMessage(packet, toBytes), qos: 1, messageId, dup }
              : { ...publishMessage(packet, toBytes), qos: 2, messageId, dup },
          );
        } else onPacket(publishMessage(packet, toBytes));
        break;
      case 'auth':
        throw new ProtocolInputError('Unexpected MQTT AUTH', 0x82);
      case 'connect':
      case 'subscribe':
      case 'unsubscribe':
      case 'pingreq':
        // The framer rejects these on the first byte.
        throw brokerPacketDirectionError(packet.cmd);
      case 'connack':
      case 'puback':
      case 'pubrec':
      case 'pubrel':
      case 'pubcomp':
      case 'suback':
      case 'unsuback':
      case 'pingresp':
      case 'disconnect':
        onPacket(packet);
    }
  };
}
