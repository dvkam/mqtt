import { expect, test } from 'vitest';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';
import { StreamingNodeDecoder } from './experiments/streaming-node-decoder.js';
import { observeFramingOccupancy } from './experiments/node-framing-occupancy.js';

const wire = Uint8Array.from([0x30, 0x84, 2, 0, 1, 97, 0, ...new Uint8Array(256).fill(120)]);

test.each([
  { strategy: 'compact' as const, fragmentBytes: 263, nativeBytes: 262, fragments: 1, assembly: 262 },
  { strategy: 'compact' as const, fragmentBytes: 1, nativeBytes: 262, fragments: 1, assembly: 262 },
  { strategy: 'streaming' as const, fragmentBytes: 263, nativeBytes: 260, fragments: 1, assembly: 0 },
  { strategy: 'streaming' as const, fragmentBytes: 1, nativeBytes: 260, fragments: 260, assembly: 0 },
])('$strategy with $fragmentBytes-byte input counts native and assembly occupancy separately', ({ strategy, fragmentBytes, nativeBytes, fragments, assembly }) => {
  let packets = 0;
  const options = { maxPacketBytes: 263, onPacket() { packets++; } };
  const decoder = strategy === 'compact' ? new NodePacketDecoder(options) : new StreamingNodeDecoder(options);
  const observation = observeFramingOccupancy(decoder, strategy);
  try {
    for (let offset = 0; offset < wire.length; offset += fragmentBytes) decoder.push(wire.subarray(offset, offset + fragmentBytes));
    expect(packets).toBe(1);
    expect(observation.snapshot()).toEqual({ peakNativeBytes: nativeBytes, peakNativeFragments: fragments, peakAssemblyCapacity: assembly, currentNativeBytes: 0, currentNativeFragments: 0, currentAssemblyCapacity: 0 });
    decoder.finish();
  } finally { observation.restore(); }
});

test('partial admitted compact input exposes assembly capacity before its body arrives', () => {
  const decoder = new NodePacketDecoder({ maxPacketBytes: 263, onPacket() {} });
  const observation = observeFramingOccupancy(decoder, 'compact');
  try {
    decoder.push(wire.subarray(0, 3));
    expect(observation.snapshot()).toMatchObject({ peakAssemblyCapacity: 262, currentAssemblyCapacity: 262, currentNativeBytes: 0 });
    decoder.stop(new Error('test retirement'));
    expect(observation.snapshot()).toMatchObject({ currentAssemblyCapacity: 0, currentNativeBytes: 0 });
  } finally { observation.restore(); }
});

test('streaming partial body counts retained one-byte fragments and released ownership', () => {
  const decoder = new StreamingNodeDecoder({ maxPacketBytes: 263, onPacket() {} });
  const observation = observeFramingOccupancy(decoder, 'streaming');
  try {
    for (const byte of wire.subarray(0, wire.length - 1)) decoder.push(Uint8Array.of(byte));
    expect(observation.snapshot()).toMatchObject({ peakNativeBytes: 259, peakNativeFragments: 259, currentNativeBytes: 259, currentNativeFragments: 259 });
    decoder.stop(new Error('test retirement'));
    expect(observation.snapshot()).toMatchObject({ currentNativeBytes: 0, currentNativeFragments: 0 });
  } finally { observation.restore(); }
});

test('unsupported private shapes fail loudly', () => {
  expect(() => observeFramingOccupancy({}, 'compact')).toThrow('Unsupported');
});
