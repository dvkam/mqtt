import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';
import { StreamingNodeDecoder } from './experiments/streaming-node-decoder.js';
import { observeFramingOccupancy } from './experiments/node-framing-occupancy.js';

const wire = Uint8Array.from([0x30, 0x84, 2, 0, 1, 97, 0, ...new Uint8Array(256).fill(120)]);

test('the measurement entry runs directly with the current Node runtime', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./bench/node-framing-occupancy.ts', import.meta.url))], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const rows = result.stdout.trim().split('\n');
  expect(rows).toHaveLength(8);
  for (const line of rows) {
    const row: unknown = JSON.parse(line);
    expect(row).toMatchObject({
      wireBytes: 263,
      afterRetirement: { currentNativeBytes: 0, currentNativeFragments: 0, currentAssemblyCapacity: 0 },
    });
  }
}, 20_000);

test.each([
  { strategy: 'compact', fragmentBytes: 263, nativeBytes: 262, fragments: 1, assembly: 262 },
  { strategy: 'compact', fragmentBytes: 1, nativeBytes: 262, fragments: 1, assembly: 262 },
  { strategy: 'streaming', fragmentBytes: 263, nativeBytes: 260, fragments: 1, assembly: 0 },
  { strategy: 'streaming', fragmentBytes: 1, nativeBytes: 260, fragments: 260, assembly: 0 },
] as const)(
  '$strategy with $fragmentBytes-byte input counts native and assembly occupancy separately',
  ({ strategy, fragmentBytes, nativeBytes, fragments, assembly }) => {
    let packets = 0;
    const options = {
      maxPacketBytes: 263,
      onPacket() {
        packets++;
      },
    };
    const decoder = strategy === 'compact' ? new NodePacketDecoder(options) : new StreamingNodeDecoder(options);
    const observation = observeFramingOccupancy(decoder, strategy);
    try {
      for (let offset = 0; offset < wire.length; offset += fragmentBytes)
        decoder.push(wire.subarray(offset, offset + fragmentBytes));
      expect(packets).toBe(1);
      expect(observation.snapshot()).toEqual({
        peakNativeBytes: nativeBytes,
        peakNativeFragments: fragments,
        peakAssemblyCapacity: assembly,
        currentNativeBytes: 0,
        currentNativeFragments: 0,
        currentAssemblyCapacity: 0,
      });
      decoder.finish();
    } finally {
      observation.restore();
    }
  },
);

test('partial admitted compact input exposes assembly capacity before its body arrives', () => {
  const decoder = new NodePacketDecoder({ maxPacketBytes: 263, onPacket() {} });
  const observation = observeFramingOccupancy(decoder, 'compact');
  try {
    decoder.push(wire.subarray(0, 3));
    expect(observation.snapshot()).toMatchObject({
      peakAssemblyCapacity: 262,
      currentAssemblyCapacity: 262,
      currentNativeBytes: 0,
    });
    decoder.stop(new Error('test retirement'));
    expect(observation.snapshot()).toMatchObject({ currentAssemblyCapacity: 0, currentNativeBytes: 0 });
  } finally {
    observation.restore();
  }
});

test('zero-body packet counts assembly capacity before immediate flush', () => {
  let packets = 0;
  const decoder = new NodePacketDecoder({
    maxPacketBytes: 2,
    onPacket() {
      packets++;
    },
  });
  const observation = observeFramingOccupancy(decoder, 'compact');
  try {
    decoder.push(Uint8Array.of(0xd0, 0));
    expect(packets).toBe(1);
    expect(observation.snapshot()).toMatchObject({
      peakNativeBytes: 1,
      peakNativeFragments: 1,
      peakAssemblyCapacity: 1,
      currentAssemblyCapacity: 0,
    });
    decoder.finish();
  } finally {
    observation.restore();
  }
});

test('streaming partial body counts retained one-byte fragments and released ownership', () => {
  const decoder = new StreamingNodeDecoder({ maxPacketBytes: 263, onPacket() {} });
  const observation = observeFramingOccupancy(decoder, 'streaming');
  try {
    for (const byte of wire.subarray(0, wire.length - 1)) decoder.push(Uint8Array.of(byte));
    expect(observation.snapshot()).toMatchObject({
      peakNativeBytes: 259,
      peakNativeFragments: 259,
      currentNativeBytes: 259,
      currentNativeFragments: 259,
    });
    decoder.stop(new Error('test retirement'));
    expect(observation.snapshot()).toMatchObject({ currentNativeBytes: 0, currentNativeFragments: 0 });
  } finally {
    observation.restore();
  }
});

test('unsupported private shapes fail loudly', () => {
  expect(() => observeFramingOccupancy({}, 'compact')).toThrow('Unsupported');
});

test('restoring hooks preserves a partially assembled decoder and method identity', () => {
  let packets = 0;
  const decoder = new NodePacketDecoder({
    onPacket() {
      packets++;
    },
  });
  const original: unknown = Reflect.get(decoder, 'flush');
  const observation = observeFramingOccupancy(decoder, 'compact');
  decoder.push(wire.subarray(0, 3));
  observation.restore();
  observation.restore();
  expect(Reflect.get(decoder, 'flush')).toBe(original);
  expect(() => observation.snapshot()).toThrow('restored');
  decoder.push(wire.subarray(3));
  decoder.finish();
  expect(packets).toBe(1);
});

test('observations remain isolated between decoder instances', () => {
  const first = new NodePacketDecoder({ onPacket() {} });
  const second = new NodePacketDecoder({ onPacket() {} });
  const firstObservation = observeFramingOccupancy(first, 'compact');
  const secondObservation = observeFramingOccupancy(second, 'compact');
  try {
    first.push(wire);
    expect(firstObservation.snapshot().peakNativeBytes).toBe(262);
    expect(secondObservation.snapshot().peakNativeBytes).toBe(0);
    second.push(Uint8Array.of(0xd0, 0));
    expect(secondObservation.snapshot().peakNativeBytes).toBe(1);
    first.finish();
    second.finish();
  } finally {
    firstObservation.restore();
    secondObservation.restore();
  }
});

test('nested observation is rejected without removing the original hooks', () => {
  const decoder = new NodePacketDecoder({ onPacket() {} });
  const observation = observeFramingOccupancy(decoder, 'compact');
  try {
    expect(() => observeFramingOccupancy(decoder, 'compact')).toThrow('already observed');
    decoder.push(wire);
    expect(observation.snapshot().peakNativeBytes).toBe(262);
    decoder.finish();
  } finally {
    observation.restore();
  }
});

test('caller cleanup restores hooks after an input callback throws', () => {
  const reason = new Error('packet callback failed');
  const decoder = new NodePacketDecoder({
    onPacket() {
      throw reason;
    },
  });
  const original: unknown = Reflect.get(decoder, 'flush');
  const observation = observeFramingOccupancy(decoder, 'compact');
  let failure: unknown;
  try {
    decoder.push(wire);
  } catch (caught) {
    failure = caught;
  } finally {
    observation.restore();
  }
  expect(failure).toBe(reason);
  expect(Reflect.get(decoder, 'flush')).toBe(original);
});

test('failed installation restores an earlier native append hook', () => {
  const decoder = new NodePacketDecoder({ onPacket() {} });
  const native: unknown = Reflect.get(decoder, 'decoder');
  if (typeof native !== 'object' || native === null) throw new Error('Expected parser');
  const list: unknown = Reflect.get(native, '_list');
  if (typeof list !== 'object' || list === null) throw new Error('Expected BufferList');
  const append: unknown = Reflect.get(list, 'append');
  Object.defineProperty(decoder, 'flush', { configurable: true, value: undefined });
  expect(() => observeFramingOccupancy(decoder, 'compact')).toThrow('Unsupported framing method');
  expect(Reflect.get(list, 'append')).toBe(append);
  Reflect.deleteProperty(decoder, 'flush');
  const observation = observeFramingOccupancy(decoder, 'compact');
  try {
    decoder.push(wire);
    expect(observation.snapshot().peakNativeBytes).toBe(262);
    decoder.finish();
  } finally {
    observation.restore();
  }
});
