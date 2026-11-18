import { nodePlatform } from './nodePlatform.js';
import { PacketInput } from './packetInput.js';

/** The packet input on Node: one unpooled Buffer per packet, and Buffer payloads. */
export class NodePacketInput extends PacketInput<Buffer> {
  constructor(maxPacketBytes?: number) {
    super(maxPacketBytes, nodePlatform);
  }
}
