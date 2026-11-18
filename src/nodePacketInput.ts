import { nodePlatform } from './nodePlatform.js';
import { PacketInput } from './packetInput.js';

/**
 * The packet input on Node: one unpooled Buffer per packet, and Buffer payloads. The clients go through the core and
 * nodePlatform; tests use this class to drive the Node input directly.
 */
export class NodePacketInput extends PacketInput<Buffer> {
  constructor(maxPacketBytes?: number) {
    super(maxPacketBytes, nodePlatform);
  }
}
