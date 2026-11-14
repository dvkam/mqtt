import { MqttPacketCompactDecoder } from './mqtt-packet-compact-decoder.ts';
import { StreamingNodeDecoder } from './streaming-node-decoder.ts';

const observed = new WeakSet();

export interface FramingOccupancy {
  readonly peakNativeBytes: number;
  readonly peakNativeFragments: number;
  readonly peakAssemblyCapacity: number;
  readonly currentNativeBytes: number;
  readonly currentNativeFragments: number;
  readonly currentAssemblyCapacity: number;
}

export function observeFramingOccupancy(decoder: unknown, strategy: 'compact' | 'streaming') {
  if (
    !(strategy === 'compact' && decoder instanceof MqttPacketCompactDecoder) &&
    !(strategy === 'streaming' && decoder instanceof StreamingNodeDecoder)
  ) {
    throw new Error('Unsupported decoder strategy');
  }
  const wrapper = requireObject(decoder);
  if (observed.has(wrapper)) throw new Error('Decoder already observed');
  const native = requireObject(Reflect.get(wrapper, 'decoder'));
  const list = requireObject(Reflect.get(native, '_list'));
  let peakNativeBytes = 0;
  let peakNativeFragments = 0;
  let peakAssemblyCapacity = 0;
  let restored = false;

  const read = () => {
    const current: unknown = Reflect.get(wrapper, 'decoder');
    if (current !== undefined && (current !== native || Reflect.get(native, '_list') !== list)) {
      throw new Error('Unsupported native decoder replacement');
    }
    const queue = current === undefined ? { bytes: 0, fragments: 0 } : readQueue(list);
    const remainder: unknown = Reflect.get(wrapper, 'remainder');
    if (strategy === 'compact' && remainder !== undefined && !Buffer.isBuffer(remainder)) {
      throw new Error('Unsupported compact remainder');
    }
    const assembly = strategy === 'compact' && Buffer.isBuffer(remainder) ? remainder.byteLength : 0;
    peakNativeBytes = Math.max(peakNativeBytes, queue.bytes);
    peakNativeFragments = Math.max(peakNativeFragments, queue.fragments);
    peakAssemblyCapacity = Math.max(peakAssemblyCapacity, assembly);
    return { queue, assembly };
  };

  const restorers: (() => void)[] = [];
  try {
    read();
    restorers.push(
      observeMethod(
        list,
        'append',
        () => {},
        () => {
          read();
        },
      ),
    );
    if (strategy === 'compact') {
      restorers.push(
        observeMethod(
          wrapper,
          'flush',
          () => {
            if (!Buffer.isBuffer(Reflect.get(wrapper, 'remainder'))) throw new Error('Unsupported compact flush fields');
            read();
          },
          () => {
            read();
          },
        ),
      );
    } else if (typeof Reflect.get(wrapper, 'streamingRemaining') !== 'number') {
      throw new Error('Unsupported streaming fields');
    }
  } catch (reason) {
    for (const restore of [...restorers].reverse()) restore();
    throw reason;
  }

  observed.add(wrapper);

  return {
    snapshot(): FramingOccupancy {
      if (restored) throw new Error('Framing observation restored');
      const { queue, assembly } = read();
      return {
        peakNativeBytes,
        peakNativeFragments,
        peakAssemblyCapacity,
        currentNativeBytes: queue.bytes,
        currentNativeFragments: queue.fragments,
        currentAssemblyCapacity: assembly,
      };
    },
    restore(): void {
      if (restored) return;
      restored = true;
      observed.delete(wrapper);
      for (const restore of [...restorers].reverse()) restore();
    },
  };
}

function requireObject(value: unknown): object {
  if (typeof value !== 'object' || value === null) throw new Error('Unsupported framing object');
  return value;
}

function readQueue(list: object) {
  const buffers: unknown = Reflect.get(list, '_bufs');
  const length: unknown = Reflect.get(list, 'length');
  if (!Array.isArray(buffers) || typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new Error('Unsupported native BufferList fields');
  }
  const fragments: readonly unknown[] = buffers;
  const bytes = fragments.reduce<number>((total, fragment: unknown) => {
    if (!Buffer.isBuffer(fragment)) throw new Error('Unsupported native fragment');
    return total + fragment.byteLength;
  }, 0);
  if (bytes !== length) throw new Error('Unsupported native BufferList accounting');
  return { bytes, fragments: fragments.length };
}

function observeMethod(owner: object, name: string, before: () => void, after: () => void): () => void {
  const method: unknown = Reflect.get(owner, name);
  if (typeof method !== 'function') throw new Error('Unsupported framing method');
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  Object.defineProperty(owner, name, {
    configurable: true,
    writable: true,
    value: function (this: unknown, ...argumentsList: readonly unknown[]): unknown {
      before();
      try {
        const result: unknown = Reflect.apply(method, this, argumentsList);
        return result;
      } finally {
        after();
      }
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(owner, name, descriptor);
    else if (!Reflect.deleteProperty(owner, name)) throw new Error('Cannot restore framing method');
  };
}
