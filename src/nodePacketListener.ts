import { inboundPacketListener } from './inboundPackets.js';
import { nodeBytes } from './nodeMessage.js';

/** The inbound rules on Node: byte fields reach the session as Buffer views. Tests use it to drive the rules directly. */
export function nodePacketListener(
  onPacket: Parameters<typeof inboundPacketListener<Buffer>>[0],
  receiveQosOne = false,
  receiveQosTwo = false,
) {
  return inboundPacketListener(onPacket, receiveQosOne, nodeBytes, receiveQosTwo);
}
