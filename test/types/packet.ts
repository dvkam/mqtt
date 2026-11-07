import type { Packet } from 'mqtt-packet';

type PacketOf<Kind extends Packet['cmd']> = Extract<Packet, { cmd: Kind }>;
type MatchCommand<Kind extends Packet['cmd'], Expected extends Kind> = { kind: Kind; expected: Expected };

type InvalidMatch<Kind extends Packet['cmd'], Expected extends Kind> = Kind extends Expected
  ? never
  : // @ts-expect-error Expected may be absent from a distributed branch.
    MatchCommand<Kind, Expected>;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This compile-only negative fixture deliberately checks an invalid distributed type or member access.
void (undefined as unknown as InvalidMatch<'publish' | 'puback', 'publish'>);

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
export function publishTopic(packet: PacketOf<'publish' | 'puback'>): string | undefined {
  if (packet.cmd === 'publish') return packet.topic;

  // @ts-expect-error PUBACK carries no topic.
  return packet.topic; // oxlint-disable-line typescript/no-unsafe-return -- PUBACK member access is deliberately invalid in this compiler regression.
}

// @ts-expect-error PUBLISH requires a topic.
const invalidPublish: PacketOf<'publish'> = { cmd: 'publish', payload: 'message', qos: 0, dup: false, retain: false };
void invalidPublish;
