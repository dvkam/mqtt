import { expect, test, vi } from 'vitest';
import { NodePacketInput } from '../src/nodePacketInput.js';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';
import { connectPortable, type PacketTransport } from '../src/portable.js';
import type { NodeMessage } from '../src/nodeMessage.js';

const publication = Uint8Array.of(0x30, 6, 0, 1, 97, 0, 104, 105);

test('an early input failure rejects core construction without writing CONNECT', async () => {
  const input = new NodePacketInput();
  const reason = new Error('failed before core construction');
  input.retire('error', reason);
  const send = vi.fn<(packet: unknown) => Promise<void>>().mockResolvedValue(undefined);
  const transport: PacketTransport<NodeMessage> = {
    send,
    listen(onPacket, onClose) {
      return input.listen(onPacket, onClose);
    },
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  await expect(connectPortable(transport, { clientId: 'early-input-failure' })).rejects.toBe(reason);
  expect(send).not.toHaveBeenCalled();
  expect(input.reason).toBe(reason);
});

test('null capacity is rejected at the JavaScript constructor boundary', () => {
  expect(() => {
    Reflect.construct(NodePacketDecoder, [{ maxPacketBytes: null, onPacket() {} }]);
  }).toThrow(RangeError);
});

test('input failure before registration replays its exact reason once', () => {
  const input = new NodePacketInput();
  const reason = new Error('native failed before listen');
  input.retire('error', reason);
  const received = vi.fn<(packet: unknown) => void>();
  const failed = vi.fn<(reason: unknown) => void>();
  const unlisten = input.listen(received, failed);
  expect(input.reason).toBe(reason);
  expect(failed).toHaveBeenCalledExactlyOnceWith(reason);
  unlisten();
  unlisten();
  input.push(publication);
  expect(received).not.toHaveBeenCalled();
});

test('terminal ownership is recorded before failure notification can unlisten', () => {
  const input = new NodePacketInput();
  const reason = new Error('abort during input');
  let observed: unknown;
  const failed = vi.fn<(reason: unknown) => void>(() => {
    observed = input.reason;
    unlisten();
  });
  const unlisten = input.listen(() => {}, failed);
  input.retire('abort', reason);
  expect(observed).toBe(reason);
  expect(input.reason).toBe(reason);
  expect(input.remoteEnd(new Error('later EOF'))).toBe(reason);
  expect(failed).toHaveBeenCalledTimes(1);
});

test('core unlisten stops a coalesced suffix without exposing its private stop reason', () => {
  const allocations = vi.spyOn(Buffer, 'allocUnsafeSlow');
  try {
    const input = new NodePacketInput();
    const received = vi.fn<(packet: unknown) => void>(() => {
      unlisten();
    });
    const failed = vi.fn<(reason: unknown) => void>();
    const unlisten = input.listen(received, failed);
    expect(input.push(Uint8Array.from([...publication, ...publication]))).toBeUndefined();
    expect(input.reason).toBeUndefined();
    expect(input.remoteEnd(new Error('later EOF'))).toBeUndefined();
    expect(input.push(publication)).toBeUndefined();
    expect(received).toHaveBeenCalledTimes(1);
    expect(allocations).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  } finally {
    allocations.mockRestore();
  }
});

test('retired input never invokes the decoder again', () => {
  const reads = vi.spyOn(NodePacketDecoder.prototype, 'push');
  try {
    const input = new NodePacketInput();
    input.push(publication);
    const reason = new Error('input retired');
    input.retire('error', reason);
    expect(input.push(publication)).toBe(reason);
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    reads.mockRestore();
  }
});

test('input-owned retirement stops coalesced input before another body allocation', () => {
  const allocations = vi.spyOn(Buffer, 'allocUnsafeSlow');
  try {
    const input = new NodePacketInput();
    const reason = new Error('abort during publication');
    const received = vi.fn<(packet: unknown) => void>(() => {
      input.retire('abort', reason);
    });
    const failed = vi.fn<(reason: unknown) => void>();
    input.listen(received, failed);
    expect(input.push(Uint8Array.from([...publication, ...publication]))).toBe(reason);
    expect(received).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledExactlyOnceWith(reason);
    expect(allocations).toHaveBeenCalledTimes(1);
  } finally {
    allocations.mockRestore();
  }
});

test('remote truncation before registration completes once and replays its cause', () => {
  const completion = vi.spyOn(NodePacketDecoder.prototype, 'finish');
  try {
    const input = new NodePacketInput();
    input.push(Uint8Array.of(0x30, 6, 0));
    const reason = input.remoteEnd(new Error('remote ended'));
    expect(reason).toMatchObject({ message: 'Truncated MQTT packet at end of input' });
    const failed = vi.fn<(reason: unknown) => void>();
    const unlisten = input.listen(() => {}, failed);
    expect(failed).toHaveBeenCalledExactlyOnceWith(reason);
    expect(input.remoteEnd(new Error('repeated EOF'))).toBe(reason);
    input.retire('error', new Error('late error'));
    expect(input.reason).toBe(reason);
    expect(completion).toHaveBeenCalledTimes(1);
    unlisten();
  } finally {
    completion.mockRestore();
  }
});

test.each(['error', 'abort'] as const)('%s with partial input bars completion and preserves first cause', (kind) => {
  const completion = vi.spyOn(NodePacketDecoder.prototype, 'finish');
  try {
    const input = new NodePacketInput();
    const failed = vi.fn<(reason: unknown) => void>();
    input.listen(() => {}, failed);
    input.push(Uint8Array.of(0x30, 6, 0));
    const reason = new Error(kind);
    input.retire(kind, reason);
    expect(input.remoteEnd(new Error('EOF'))).toBe(reason);
    expect(input.retire('error', new Error('later'))).toBe(reason);
    expect(failed).toHaveBeenCalledExactlyOnceWith(reason);
    expect(completion).not.toHaveBeenCalled();
  } finally {
    completion.mockRestore();
  }
});

test('core retirement with partial input never calls completion or notifies again', () => {
  const completion = vi.spyOn(NodePacketDecoder.prototype, 'finish');
  try {
    const input = new NodePacketInput();
    const failed = vi.fn<(reason: unknown) => void>();
    const unlisten = input.listen(() => {}, failed);
    input.push(Uint8Array.of(0x30, 6, 0));
    unlisten();
    input.detachCore();
    expect(input.remoteEnd(new Error('later EOF'))).toBeUndefined();
    expect(input.retire('abort', new Error('later abort'))).toBeUndefined();
    expect(input.reason).toBeUndefined();
    expect(completion).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  } finally {
    completion.mockRestore();
  }
});
