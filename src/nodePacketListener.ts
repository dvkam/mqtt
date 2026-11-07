import type { IPublishPacket, Packet } from 'mqtt-packet';
import type { NodeMessage } from './nodeMessage.js';

type ReceivedPacket = Exclude<Packet, IPublishPacket> | NodeMessage;

function isQosZeroBuffer(message: Readonly<{ qos: unknown; payload: unknown }>): message is Readonly<{ qos: 0; payload: Buffer }> {
  return message.qos === 0 && Buffer.isBuffer(message.payload);
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The observer accepts mutable parser packets; deep readonly types would change the public payload contract.
export function nodePacketListener(onPacket: (packet: ReceivedPacket) => void) {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The listener forwards the parser's original mutable packets and Buffer payloads.
  return (packet: Packet) => {
    if (packet.cmd !== 'publish' || isQosZeroBuffer(packet)) onPacket(packet);
  };
}
