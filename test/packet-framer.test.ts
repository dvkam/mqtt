import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';
import { PacketFramer } from '../src/packetFramer.js';

// A QoS 0 PUBLISH to topic 't' with Correlation Data [7, 8] and payload 'xy'.
const publication = Uint8Array.of(0x30, 11, 0, 1, 0x74, 5, 0x09, 0, 2, 7, 8, 0x78, 0x79);

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Both framers take native mutable byte views.
function decodeWith(framer: (onPacket: (packet: unknown) => void) => Readonly<{ push(bytes: Readonly<Uint8Array>): void }>) {
  const received = vi.fn<(packet: unknown) => void>();
  framer(received).push(publication);
  expect(received).toHaveBeenCalledTimes(1);
  const packet = received.mock.calls[0]?.[0];
  if (typeof packet !== 'object' || packet === null || !('payload' in packet) || !('correlationData' in packet))
    throw new Error('Expected a PUBLISH with Correlation Data');
  const { payload, correlationData } = packet;
  if (!(payload instanceof Uint8Array) || !(correlationData instanceof Uint8Array)) throw new Error('Expected byte fields');
  return { payload, correlationData };
}

test('the portable framer gives plain Uint8Array views of one allocation by default', () => {
  const { payload, correlationData } = decodeWith((onPacket) => new PacketFramer({ onPacket }));
  expect(Buffer.isBuffer(payload)).toBe(false);
  expect(Buffer.isBuffer(correlationData)).toBe(false);
  expect([...payload]).toEqual([0x78, 0x79]);
  expect([...correlationData]).toEqual([7, 8]);
  expect(payload.buffer).toBe(correlationData.buffer);
  expect(payload.buffer.byteLength).toBe(publication.length - 1);
});

test('the Node decoder gives Buffer views of one unpooled allocation', () => {
  const { payload, correlationData } = decodeWith((onPacket) => new NodePacketDecoder({ onPacket }));
  expect(Buffer.isBuffer(payload)).toBe(true);
  expect(Buffer.isBuffer(correlationData)).toBe(true);
  expect(payload.buffer).toBe(correlationData.buffer);
  expect(payload.buffer.byteLength).toBe(publication.length - 1);
});

test('the framer calls the injected allocator once per packet with the size after the fixed header', () => {
  const sizes: number[] = [];
  const allocate = (size: number) => {
    sizes.push(size);
    return new Uint8Array(size);
  };
  const framer = new PacketFramer({ allocate, onPacket() {} });
  framer.push(Uint8Array.of(...publication, 0xd0, 0, ...publication));
  expect(sizes).toEqual([publication.length - 1, 1, publication.length - 1]);
});

test('the framer checks the packet limit before it allocates', () => {
  const allocate = vi.fn<(size: number) => Uint8Array<ArrayBuffer>>((size) => new Uint8Array(size));
  const framer = new PacketFramer({ maxPacketBytes: 8, allocate, onPacket() {} });
  expect(() => {
    framer.push(publication);
  }).toThrow('MQTT packet allocation limit exceeded');
  expect(allocate).not.toHaveBeenCalled();
});

test('the framer source uses no Node API, so the browser can bundle it', () => {
  const source = readFileSync(new URL('../src/packetFramer.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/\bBuffer\b|node:/u);
});
