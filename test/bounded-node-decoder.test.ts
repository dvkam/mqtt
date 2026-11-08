import { parser } from 'mqtt-packet';
import { expect, test, vi } from 'vitest';
import { StreamingNodeDecoder } from './experiments/streaming-node-decoder.js';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';

const publication = Uint8Array.of(0x30, 6, 0, 1, 97, 0, 104, 105);
const broadVectors = [
  [0x30, 9, 0, 1, 97, 4, 3, 0, 1, 120, 104],
  [0x32, 7, 0, 1, 97, 0, 7, 0, 104],
  [0x20, 8, 0, 0, 5, 0x27, 0, 0, 16, 0],
  [0xf0, 2, 0, 0],
  [0xe0, 2, 128, 0],
  [0xb0, 4, 0, 7, 0, 0],
  [0x40, 2, 0, 7],
];

function nativePackets(bytes: readonly number[]): unknown[] {
  const packets: unknown[] = [];
  const decoder = parser({ protocolVersion: 5 });
  decoder.on('packet', (packet: unknown) => {
    packets.push(packet);
  });
  decoder.on('error', (reason: unknown) => {
    throw reason instanceof Error ? reason : new Error('Unexpected native parser failure');
  });
  decoder.parse(Buffer.from(bytes));
  return packets;
}

test('streaming gate admits a packet without allocating compact body storage', () => {
  const received = vi.fn<(packet: unknown) => void>();
  const allocations = vi.spyOn(Buffer, 'allocUnsafeSlow');
  try {
    const decoder = createCandidateDecoder({ maxPacketBytes: 8, assembly: 'streaming', onPacket: received });
    decoder.push(publication);
    expect(received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cmd: 'publish' }));
    expect(allocations).not.toHaveBeenCalled();
  } finally {
    allocations.mockRestore();
  }
});

test('streaming gate rejects declared excess and preserves failure across EOF', () => {
  const received = vi.fn<(packet: unknown) => void>();
  const decoder = createCandidateDecoder({ maxPacketBytes: 8, assembly: 'streaming', onPacket: received });
  decoder.push(Uint8Array.of(0xd0, 0));
  const failure = captureFailure(() => {
    decoder.push(Uint8Array.of(0x30, 7));
  });
  expect(failure).toMatchObject({ message: 'MQTT packet allocation limit exceeded' });
  expect(
    captureFailure(() => {
      decoder.push(publication);
    }),
  ).toBe(failure);
  expect(
    captureFailure(() => {
      decoder.finish();
    }),
  ).toBe(failure);
  expect(received).toHaveBeenCalledTimes(1);
});

test.each(['zero', 'body'])('streaming callback retirement fences a %s packet suffix', (kind) => {
  const reason = new Error('retire streaming input');
  const received = vi.fn<(packet: unknown) => void>(() => {
    decoder.stop(reason);
  });
  const decoder = createCandidateDecoder({ assembly: 'streaming', onPacket: received });
  const bytes = kind === 'zero' ? Uint8Array.of(0xd0, 0, 0xd0, 0) : Uint8Array.from([...publication, ...publication]);
  expect(
    captureFailure(() => {
      decoder.push(bytes);
    }),
  ).toBe(reason);
  expect(
    captureFailure(() => {
      decoder.finish();
    }),
  ).toBe(reason);
  expect(received).toHaveBeenCalledTimes(1);
});

test.each([0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 268_435_461])(
  'bounded Node decoder rejects packet capacity %s',
  (maxPacketBytes) => {
    expect(() => createCandidateDecoder({ maxPacketBytes, onPacket() {} })).toThrow(RangeError);
  },
);

test('oversized declaration rejects before body allocation or native body admission', () => {
  const allocations = vi.spyOn(Buffer, 'allocUnsafeSlow');
  try {
    const decoder = createCandidateDecoder({ maxPacketBytes: 12, onPacket() {} });
    decoder.push(Uint8Array.of(0x30));
    expect(() => {
      decoder.push(Uint8Array.of(11));
    }).toThrow('MQTT packet allocation limit exceeded');
    expect(allocations).not.toHaveBeenCalled();
  } finally {
    allocations.mockRestore();
  }
});

test('waits for the complete body before native payload decoding', () => {
  const received = vi.fn<(packet: unknown) => void>();
  const decoder = createCandidateDecoder({ maxPacketBytes: 8, onPacket: received });
  expect(() => {
    decoder.push(publication.subarray(0, 2));
  }).not.toThrow();
  expect(received).not.toHaveBeenCalled();
  decoder.push(publication.subarray(2));
  expect(received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cmd: 'publish', payload: Buffer.from('hi') }));
});

test.each(
  broadVectors.flatMap((bytes: readonly number[]) => (['compact', 'streaming'] as const).map((assembly) => ({ bytes, assembly }))),
)(
  '$assembly retains native packet profile for $bytes',
  ({ bytes, assembly }: Readonly<{ bytes: readonly number[]; assembly: 'compact' | 'streaming' }>) => {
    const expected = nativePackets(bytes);
    expect(expected).toHaveLength(1);
    for (let split = 0; split <= bytes.length; split++) {
      const actual: unknown[] = [];
      const decoder = createCandidateDecoder({
        maxPacketBytes: bytes.length,
        assembly,
        onPacket: (packet: unknown) => {
          actual.push(packet);
        },
      });
      decoder.push(Uint8Array.from(bytes.slice(0, split)));
      decoder.push(Uint8Array.from(bytes.slice(split)));
      decoder.finish();
      expect(actual).toEqual(expected);
    }
  },
);

test.each([0x21, 0x36])('retains immediate native first-byte rejection for %s', (header) => {
  const decoder = createCandidateDecoder({ onPacket() {} });
  expect(() => {
    decoder.push(Uint8Array.of(header));
  }).toThrow(Error);
});

test('fourth length continuation fails immediately and permanently', () => {
  const received = vi.fn<(packet: unknown) => void>();
  const decoder = createCandidateDecoder({ onPacket: received });
  decoder.push(Uint8Array.of(0xd0, 0x80, 0x80, 0x80));
  const failure = captureFailure(() => {
    decoder.push(Uint8Array.of(0x80));
  });
  expect(failure).toBeInstanceOf(Error);
  expect(
    captureFailure(() => {
      decoder.push(Uint8Array.of(0xd0, 0));
    }),
  ).toBe(failure);
  expect(received).not.toHaveBeenCalled();
});

test('preserves nonminimal Remaining Length with total wire accounting', () => {
  const received = vi.fn<(packet: unknown) => void>();
  const decoder = createCandidateDecoder({ maxPacketBytes: 3, onPacket: received });
  decoder.push(Uint8Array.of(0xd0, 0x80));
  decoder.push(Uint8Array.of(0));
  decoder.finish();
  expect(received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cmd: 'pingresp' }));
  const smaller = createCandidateDecoder({ maxPacketBytes: 2, onPacket() {} });
  expect(() => {
    smaller.push(Uint8Array.of(0xd0, 0x80, 0));
  }).toThrow('MQTT packet allocation limit exceeded');
});

test('delivers an accepted prefix before rejecting an oversized suffix', () => {
  const packets: unknown[] = [];
  const decoder = createCandidateDecoder({
    maxPacketBytes: 8,
    onPacket: (packet: unknown) => {
      packets.push(packet);
    },
  });
  expect(() => {
    decoder.push(Uint8Array.from([0xd0, 0, 0x30, 7]));
  }).toThrow('MQTT packet allocation limit exceeded');
  expect(packets).toMatchObject([{ cmd: 'pingresp' }]);
});

test('native first-byte error cannot reset on later input', () => {
  const received = vi.fn<(packet: unknown) => void>();
  const decoder = createCandidateDecoder({ onPacket: received });
  const failure = captureFailure(() => {
    decoder.push(Uint8Array.of(0x21));
  });
  expect(
    captureFailure(() => {
      decoder.push(publication);
    }),
  ).toBe(failure);
  expect(
    captureFailure(() => {
      decoder.finish();
    }),
  ).toBe(failure);
  expect(received).not.toHaveBeenCalled();
});

test('callback throw preserves the original error and fences a coalesced suffix', () => {
  const reason = new Error('consumer failed');
  const received = vi.fn<(packet: unknown) => void>(() => {
    throw reason;
  });
  const decoder = createCandidateDecoder({ onPacket: received });
  expect(
    captureFailure(() => {
      decoder.push(Uint8Array.from([...publication, ...publication]));
    }),
  ).toBe(reason);
  expect(
    captureFailure(() => {
      decoder.push(publication);
    }),
  ).toBe(reason);
  expect(received).toHaveBeenCalledTimes(1);
});

test('retirement in a zero-body callback stops the remaining coalesced input', () => {
  const reason = new Error('connection aborted');
  const received = vi.fn<(packet: unknown) => void>(() => {
    decoder.stop(reason);
  });
  const decoder = createCandidateDecoder({ onPacket: received });
  expect(
    captureFailure(() => {
      decoder.push(Uint8Array.of(0xd0, 0, 0xd0, 0));
    }),
  ).toBe(reason);
  expect(
    captureFailure(() => {
      decoder.finish();
    }),
  ).toBe(reason);
  expect(received).toHaveBeenCalledTimes(1);
});

test('payload owns compact mutable storage independent of the input batch', () => {
  let payload: Buffer | undefined;
  const decoder = createCandidateDecoder({
    maxPacketBytes: 8,
    onPacket(packet: unknown) {
      if (typeof packet === 'object' && packet !== null && 'payload' in packet && Buffer.isBuffer(packet.payload))
        payload = packet.payload;
    },
  });
  const input = new Uint8Array(4096);
  input.set(publication);
  for (let offset = publication.length; offset < input.length; offset += 2) input.set([0xd0, 0], offset);
  decoder.push(input);
  expect(payload).toBeInstanceOf(Buffer);
  if (!payload) throw new Error('Expected publication payload');
  expect(payload.buffer.byteLength).toBeLessThanOrEqual(8);
  input.fill(0);
  expect(payload.toString()).toBe('hi');
  payload[0] = 72;
  expect(payload.toString()).toBe('Hi');
});

test.each([[0x30], [0x30, 0x80], [0x30, 6, 0]])('remote EOF rejects partial input %j once', (...bytes: readonly number[]) => {
  const decoder = createCandidateDecoder({ onPacket() {} });
  decoder.push(Uint8Array.from(bytes));
  const failure = captureFailure(() => {
    decoder.finish();
  });
  expect(failure).toMatchObject({ message: 'Truncated MQTT packet at end of input' });
  expect(
    captureFailure(() => {
      decoder.finish();
    }),
  ).toBe(failure);
  expect(
    captureFailure(() => {
      decoder.push(publication);
    }),
  ).toBe(failure);
});

test('finish at a packet boundary is idempotent and prevents later parsing', () => {
  const received = vi.fn<(packet: unknown) => void>();
  const decoder = createCandidateDecoder({ onPacket: received });
  decoder.push(publication);
  decoder.finish();
  decoder.finish();
  expect(() => {
    decoder.push(publication);
  }).toThrow('MQTT decoder has ended');
  expect(received).toHaveBeenCalledTimes(1);
});

test.each([
  [0x30, 0x80, 1],
  [0x30, 0x80, 0x80, 1],
  [0x30, 0xff, 0xff, 0xff, 0x7f],
])('rejects oversized multi-byte declaration at every split %j', (...bytes: readonly number[]) => {
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = createCandidateDecoder({ maxPacketBytes: 130, onPacket() {} });
    expect(() => {
      decoder.push(Uint8Array.from(bytes.slice(0, split)));
      decoder.push(Uint8Array.from(bytes.slice(split)));
    }).toThrow('MQTT packet allocation limit exceeded');
  }
});

test('default capacity rejects an oversized declaration without its body', () => {
  const decoder = createCandidateDecoder({ onPacket() {} });
  expect(() => {
    decoder.push(Uint8Array.of(0x30, 0x80, 0x80, 0x40));
  }).toThrow('MQTT packet allocation limit exceeded');
});

test('fragment copies survive caller mutation before packet completion', () => {
  const packets: unknown[] = [];
  const decoder = createCandidateDecoder({
    maxPacketBytes: 8,
    onPacket: (packet: unknown) => {
      packets.push(packet);
    },
  });
  const first = publication.slice(0, 7);
  decoder.push(first);
  expect(packets).toEqual([]);
  first.fill(0);
  decoder.push(publication.subarray(7));
  expect(packets).toMatchObject([{ cmd: 'publish', topic: 'a', payload: Buffer.from('hi') }]);
});

test.each([[0x30], [0x30, 0x80], [0x30, 6, 0]])('stop keeps its reason ahead of partial EOF %j', (...bytes: readonly number[]) => {
  const reason = new Error('connection cancelled');
  const decoder = createCandidateDecoder({ onPacket() {} });
  decoder.push(Uint8Array.from(bytes));
  decoder.stop(reason);
  expect(
    captureFailure(() => {
      decoder.finish();
    }),
  ).toBe(reason);
  expect(
    captureFailure(() => {
      decoder.push(publication);
    }),
  ).toBe(reason);
});

test.each(['push', 'finish'] as const)('reentrant %s fails permanently before another native parse', (operation) => {
  const received = vi.fn<(packet: unknown) => void>(() => {
    if (operation === 'push') decoder.push(publication);
    else decoder.finish();
  });
  const decoder = createCandidateDecoder({ onPacket: received });
  const failure = captureFailure(() => {
    decoder.push(publication);
  });
  expect(failure).toBeInstanceOf(Error);
  expect(
    captureFailure(() => {
      decoder.push(publication);
    }),
  ).toBe(failure);
  expect(received).toHaveBeenCalledTimes(1);
});

test.each(['compact', 'streaming'] as const)('single-packet %s callback retirement is reported before push returns', (assembly) => {
  const reason = new Error('retire at final callback');
  const received = vi.fn<(packet: unknown) => void>(() => {
    decoder.stop(reason);
  });
  const decoder = createCandidateDecoder({ assembly, onPacket: received });
  expect(
    captureFailure(() => {
      decoder.push(Uint8Array.of(0xd0, 0));
    }),
  ).toBe(reason);
  expect(received).toHaveBeenCalledTimes(1);
});

test('native payload rejection keeps its error ahead of later input and EOF', () => {
  const received = vi.fn<(packet: unknown) => void>();
  const decoder = createCandidateDecoder({ onPacket: received });
  const failure = captureFailure(() => {
    decoder.push(Uint8Array.of(0x30, 0));
  });
  expect(failure).toBeInstanceOf(Error);
  expect(
    captureFailure(() => {
      decoder.push(publication);
    }),
  ).toBe(failure);
  expect(
    captureFailure(() => {
      decoder.finish();
    }),
  ).toBe(failure);
  expect(received).not.toHaveBeenCalled();
});

function captureFailure(operation: () => void): unknown {
  try {
    operation();
    return undefined;
  } catch (reason) {
    return reason;
  }
}

type CandidateOptions = ConstructorParameters<typeof StreamingNodeDecoder>[0] & Readonly<{ assembly?: 'compact' | 'streaming' }>;

function createCandidateDecoder(options: CandidateOptions) {
  return options.assembly === 'streaming' ? new StreamingNodeDecoder(options) : new NodePacketDecoder(options);
}
