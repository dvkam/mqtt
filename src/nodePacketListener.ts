import { inboundPacketListener } from './inboundPackets.js';
import { nodeBytes } from './nodeMessage.js';
import type { ReceivedPacket } from './portable.js';

/** The inbound rules on Node: byte fields reach the session as Buffer views. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The observer accepts mutable packets; deep readonly types would change the public payload contract.
export function nodePacketListener(onPacket: (packet: ReceivedPacket<Buffer>) => void, receiveQosOne = false) {
  return inboundPacketListener(onPacket, receiveQosOne, nodeBytes);
}
