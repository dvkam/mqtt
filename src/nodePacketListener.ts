import { inboundPacketListener } from './inboundPackets.js';
import { nodeBytes } from './nodeMessage.js';
import type { ReceivedPacket } from './portable.js';

/** The inbound rules on Node: byte fields reach the session as Buffer views. Tests use it to drive the rules directly. */
export function nodePacketListener(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The observer accepts mutable packets; deep readonly types would change the public payload contract.
  onPacket: (packet: ReceivedPacket<Buffer>) => void,
  receiveQosOne = false,
  receiveQosTwo = false,
) {
  return inboundPacketListener(onPacket, receiveQosOne, nodeBytes, receiveQosTwo);
}
