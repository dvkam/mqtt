// The custom transport example from docs/public-types.md, compiled against the built declarations.
import { encodePacket, PacketDecoder } from '../../dist/codec.js';
import { connectPortable, ProtocolInputError, type PacketTransport } from '../../dist/portable.js';

interface ByteChannel {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The channel writes the bytes the encoder returns.
  write(bytes: Uint8Array): Promise<void>;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The channel hands the transport its own mutable chunks.
  onData(receive: (chunk: Uint8Array) => void, closed: (error: Error) => void): () => void;
  close(force?: boolean): Promise<void>;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
export async function connectOverChannel(channel: ByteChannel) {
  const decoder = new PacketDecoder();
  const transport: PacketTransport = {
    // encodePacket refuses $share/ filters unless asked, so the session refuses them locally first.
    supportsSharedSubscriptions: false,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    async send(packet) {
      await channel.write(encodePacket(packet));
    },
    listen(onPacket, onClose, onProtocolError) {
      // A protocol error lets the session send DISCONNECT with its reason code. Any other error closes the session.
      const fail = (error: Readonly<Error>) => {
        if (error instanceof ProtocolInputError && onProtocolError) onProtocolError(error);
        else onClose(error);
      };
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
      return channel.onData((chunk) => {
        const batch = decoder.pushBatch(chunk);
        const packets = Array.isArray(batch) ? batch : batch.packets;
        for (const packet of packets) {
          if (packet.cmd === 'connect' || packet.cmd === 'subscribe' || packet.cmd === 'unsubscribe' || packet.cmd === 'pingreq') {
            fail(new ProtocolInputError('Unexpected MQTT packet from broker: ' + packet.cmd.toUpperCase(), 0x82));
            return;
          }
          if (packet.cmd !== 'publish') onPacket(packet);
          else if (packet.qos === 1) onPacket({ ...packet, dup: packet.dup ?? false, retain: packet.retain ?? false });
          else onPacket({ ...packet, qos: 0, dup: false, retain: packet.retain ?? false });
        }
        if (!Array.isArray(batch)) fail(batch.error);
      }, onClose);
    },
    close: async (force) => channel.close(force),
  };
  return connectPortable(transport, { clientId: 'sensor-7' });
}
