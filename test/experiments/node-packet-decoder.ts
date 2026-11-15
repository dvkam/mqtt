import type { FramedPacket } from '../../src/wireCodec.js';
import { NodePacketDecoder as SupportedDecoder } from '../../src/nodePacketDecoder.js';

type Options = Readonly<{
  maxPacketBytes?: number;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Decoded packets carry mutable byte views.
  onPacket: (packet: FramedPacket) => void;
}>;

/** The supported decoder with the Remaining Length argument dropped, so a test mock sees only the packet. */
export class NodePacketDecoder extends SupportedDecoder {
  constructor(options: Options) {
    super({
      maxPacketBytes: options.maxPacketBytes,
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Decoded packets carry mutable byte views.
      onPacket: (packet) => {
        options.onPacket(packet);
      },
    });
  }
}
