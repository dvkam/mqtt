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

test('the framer allocates as soon as the Remaining Length is complete, before the body arrives', () => {
  const sizes: number[] = [];
  const received = vi.fn<(packet: unknown) => void>();
  const framer = new PacketFramer({
    allocate(size) {
      sizes.push(size);
      return new Uint8Array(size);
    },
    onPacket: received,
  });
  framer.push(publication.subarray(0, 1));
  expect(sizes).toEqual([]);
  framer.push(publication.subarray(1, 2));
  expect(sizes).toEqual([publication.length - 1]);
  framer.push(publication.subarray(2, 7));
  expect(received).not.toHaveBeenCalled();
  framer.push(publication.subarray(7));
  expect(received).toHaveBeenCalledTimes(1);
  framer.finish();
});

test('the default framer keeps the first failure and rejects later input', () => {
  const framer = new PacketFramer({ onPacket() {} });
  expect(() => {
    framer.push(Uint8Array.of(0x21));
  }).toThrow('Invalid header flag bits, must be 0x0 for connack packet');
  expect(() => {
    framer.push(Uint8Array.of(0xd0, 0));
  }).toThrow('Invalid header flag bits, must be 0x0 for connack packet');
  expect(() => {
    framer.finish();
  }).toThrow('Invalid header flag bits, must be 0x0 for connack packet');
});

test('the default framer reports a packet cut short at the end of input', () => {
  const framer = new PacketFramer({ onPacket() {} });
  framer.push(publication.subarray(0, 5));
  expect(() => {
    framer.finish();
  }).toThrow('Truncated MQTT packet at end of input');
});

test('an allocator that throws fails the framer with its error', () => {
  const failure = new Error('out of memory');
  const framer = new PacketFramer({
    allocate() {
      throw failure;
    },
    onPacket() {},
  });
  expect(() => {
    framer.push(publication);
  }).toThrow(failure);
  expect(() => {
    framer.push(Uint8Array.of(0xd0, 0));
  }).toThrow(failure);
});

test.each([
  ['shorter', -1],
  ['longer', 1],
])('an allocator that returns a %s region fails the framer instead of mis-framing', (_name, difference) => {
  const received = vi.fn<(packet: unknown) => void>();
  const framer = new PacketFramer({ allocate: (size) => new Uint8Array(size + difference), onPacket: received });
  expect(() => {
    framer.push(Uint8Array.of(...publication, 0xd0, 0));
  }).toThrow('MQTT packet allocator returned the wrong size');
  expect(received).not.toHaveBeenCalled();
});

test('the Node decoder reads options by name, including inherited ones', () => {
  expect(() => {
    Reflect.construct(NodePacketDecoder, [undefined]);
  }).toThrow(TypeError);
  const received = vi.fn<(packet: unknown) => void>();
  const inherited: unknown = Object.create({ maxPacketBytes: 4, onPacket: received });
  const decoder: unknown = Reflect.construct(NodePacketDecoder, [inherited]);
  if (!(decoder instanceof NodePacketDecoder)) throw new Error('Expected a decoder');
  expect(() => {
    decoder.push(publication);
  }).toThrow('MQTT packet allocation limit exceeded');
});

test('an allocator that stops the framer fails the push with the stop reason instead of looping', () => {
  const reason = new Error('stopped by allocator');
  const received = vi.fn<(packet: unknown) => void>();
  const framer: PacketFramer = new PacketFramer({
    allocate(size) {
      framer.stop(reason);
      return new Uint8Array(size);
    },
    onPacket: received,
  });
  expect(() => {
    framer.push(Uint8Array.of(...publication, 0xd0, 0));
  }).toThrow(reason);
  expect(received).not.toHaveBeenCalled();
  expect(() => {
    framer.finish();
  }).toThrow(reason);
});

test('the Node decoder ignores an allocator a JavaScript caller passes', () => {
  const allocate = vi.fn<(size: number) => Uint8Array<ArrayBuffer>>((size) => new Uint8Array(size));
  const { payload } = decodeWith((onPacket) => {
    const decoder: unknown = Reflect.construct(NodePacketDecoder, [{ allocate, onPacket }]);
    if (!(decoder instanceof NodePacketDecoder)) throw new Error('Expected a decoder');
    return decoder;
  });
  expect(allocate).not.toHaveBeenCalled();
  expect(Buffer.isBuffer(payload)).toBe(true);
});
