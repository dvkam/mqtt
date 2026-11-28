import type { Packet } from 'mqtt-packet';

type PacketOf<Kind extends Packet['cmd']> = Extract<Packet, { cmd: Kind }>;
type MatchCommand<Kind extends Packet['cmd'], Expected extends Kind> = { kind: Kind; expected: Expected };

type InvalidMatch<Kind extends Packet['cmd'], Expected extends Kind> = Kind extends Expected
  ? never
  : // @ts-expect-error Expected may be absent from a distributed branch.
    MatchCommand<Kind, Expected>;
const invalidDistributedMatch: InvalidMatch<'publish' | 'puback', 'publish'> | undefined = undefined;
Object.is(invalidDistributedMatch, undefined);

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- PacketOf takes the PUBLISH and PUBACK types of mqtt-packet as published, with their Buffer payloads, which have no read-only form. A narrowed copy of the types would no longer fail when the upstream declaration changes.
export function publishTopic(packet: PacketOf<'publish' | 'puback'>): string | undefined {
  if (packet.cmd === 'publish') return packet.topic;

  // @ts-expect-error PUBACK carries no topic.
  const topic: unknown = packet.topic;
  return typeof topic === 'string' ? topic : undefined;
}

// @ts-expect-error PUBLISH requires a topic.
export const invalidPublish: PacketOf<'publish'> = { cmd: 'publish', payload: 'message', qos: 0, dup: false, retain: false };
