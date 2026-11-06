import type { Packet } from 'mqtt-packet';

type PacketOf<Kind extends Packet['cmd']> = Extract<Packet, { cmd: Kind }>;

export function publishTopic(packet: PacketOf<'publish' | 'puback'>): string | undefined {
  if (packet.cmd === 'publish') return packet.topic;

  // @ts-expect-error PUBACK carries no topic.
  return packet.topic;
}

// @ts-expect-error PUBLISH requires a topic.
const invalidPublish: PacketOf<'publish'> = { cmd: 'publish', payload: 'message' };
void invalidPublish;
