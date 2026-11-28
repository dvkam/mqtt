import type { ClientPacket } from '../../src/codec.js';
import type { ReceivedPacket } from '../../src/portable.js';
import type { ReadonlyDeep } from '../../src/util/bytes.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The UTF-8 bytes of `text`, as the session sends a string payload. */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** The text of a sent PUBLISH payload, or undefined for any other packet. */
export function sentText(packet: ReadonlyDeep<ClientPacket> | undefined): string | undefined {
  return packet?.cmd === 'publish' ? decoder.decode(packet.payload) : undefined;
}

/** The message a broker that echoes publications delivers for a sent PUBLISH. */
export function echo(packet: ReadonlyDeep<Extract<ClientPacket, { cmd: 'publish' }>>): ReceivedPacket {
  const base = { cmd: 'publish', topic: packet.topic, payload: packet.payload, retain: packet.retain ?? false } as const;
  return packet.qos === 1
    ? { ...base, qos: 1, messageId: packet.messageId, dup: packet.dup ?? false }
    : { ...base, qos: 0, dup: false };
}
