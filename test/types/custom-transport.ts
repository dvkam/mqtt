// The custom transport example from docs/public-types.md, compiled against the built declarations.
import { encodePacket, PacketDecoder } from '../../dist/codec.js';
import { connectPortable, type PacketTransport } from '../../dist/portable.js';

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
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    async send(packet) {
      await channel.write(encodePacket(packet));
    },
    listen(onPacket, onClose) {
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
      return channel.onData((chunk) => {
        for (const packet of decoder.push(chunk)) {
          if (packet.cmd === 'connect' || packet.cmd === 'subscribe' || packet.cmd === 'unsubscribe' || packet.cmd === 'pingreq') {
            onClose(new Error('Unexpected MQTT packet from broker'));
            return;
          }
          if (packet.cmd !== 'publish') onPacket(packet);
          else if (packet.qos === 1) onPacket({ ...packet, dup: packet.dup ?? false, retain: packet.retain ?? false });
          else onPacket({ ...packet, qos: 0, dup: false, retain: packet.retain ?? false });
        }
      }, onClose);
    },
    close: async (force) => channel.close(force),
  };
  return connectPortable(transport, { clientId: 'sensor-7' });
}
