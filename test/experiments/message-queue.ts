import type { BrowserMessage } from '../../src/browserClient.js';

export interface QueueLimits {
  maxMessages: number;
  maxBytes: number;
}

export interface QueueSnapshot {
  messages: number;
  bytes: number;
  peakMessages: number;
  peakBytes: number;
}

export interface MessageQueue {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Incoming publications preserve the browser client's mutable native payload type.
  push: (message: Readonly<BrowserMessage>) => void;
  close(): void;
  fail(reason: unknown): void;
  iterate(): AsyncIterableIterator<BrowserMessage>;
  stream(): ReadableStream<BrowserMessage>;
  snapshot(): QueueSnapshot;
}

export function createMessageQueue(limits: Readonly<QueueLimits>): MessageQueue {
  const { maxMessages, maxBytes } = limits;
  for (const capacity of [maxMessages, maxBytes]) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new RangeError('Queue capacities must be positive safe integers');
  }
  let state: 'open' | 'closing' | 'cancelled' | 'failed' = 'open';
  let failure: unknown;
  let claimed = false;
  let notifyTerminal: (() => void) | undefined;
  const entries: { message: BrowserMessage; weight: number }[] = [];
  let bytes = 0;
  let peakMessages = 0;
  let peakBytes = 0;
  let pending:
    | {
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Iterator results carry the consumer's owned mutable payload.
        resolve: (result: IteratorResult<BrowserMessage>) => void;
        reject: (reason: unknown) => void;
      }
    | undefined;
  const clear = () => {
    entries.length = 0;
    bytes = 0;
  };
  const cancel = () => {
    if (state === 'cancelled' || state === 'failed') return;
    state = 'cancelled';
    notifyTerminal = undefined;
    clear();
    const waiting = pending;
    pending = undefined;
    waiting?.resolve({ done: true, value: undefined });
  };
  const fail = (reason: unknown) => {
    if (state !== 'open') return;
    state = 'failed';
    failure = reason;
    clear();
    const waiting = pending;
    pending = undefined;
    waiting?.reject(reason);
    notifyTerminal?.();
  };
  const claim = (): AsyncIterableIterator<BrowserMessage> => {
    if (claimed) throw new Error('A message consumer already owns this queue');
    claimed = true;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (state === 'failed') throw failure;
        const entry = entries.shift();
        if (entry !== undefined) {
          bytes -= entry.weight;
          return { done: false, value: entry.message };
        }
        if (state !== 'open') return { done: true, value: undefined };
        if (pending !== undefined) throw new Error('A message read is already pending');
        return new Promise<IteratorResult<BrowserMessage>>((resolve, reject) => {
          pending = { resolve, reject };
        });
      },
      async return() {
        cancel();
        return Promise.resolve({ done: true, value: undefined });
      },
      async throw(reason: unknown) {
        cancel();
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Iterator.throw preserves the consumer's rejection value.
        return Promise.reject(reason);
      },
    };
  };
  return {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Incoming publications preserve the browser client's mutable native payload type.
    push(message) {
      if (state !== 'open') return;
      const weight =
        message.payload.byteLength +
        message.topic.length * 2 +
        (message.userProperties ?? []).reduce((total, [key, value]) => total + (key.length + value.length) * 2, 0);
      if (entries.length >= maxMessages || weight > maxBytes - bytes) {
        fail(new Error('Application message queue capacity exceeded'));
        return;
      }
      const owned: BrowserMessage = {
        cmd: 'publish',
        topic: message.topic,
        payload: Uint8Array.from(message.payload),
        qos: 0,
        dup: false,
        retain: message.retain,
        userProperties: message.userProperties?.map(([key, value]) => [key, value]),
      };
      const waiting = pending;
      if (waiting !== undefined) {
        pending = undefined;
        waiting.resolve({ done: false, value: owned });
      } else {
        entries.push({ message: owned, weight });
        bytes += weight;
        peakMessages = Math.max(peakMessages, entries.length);
        peakBytes = Math.max(peakBytes, bytes);
      }
    },
    close() {
      if (state !== 'open') return;
      state = 'closing';
      const waiting = pending;
      pending = undefined;
      waiting?.resolve({ done: true, value: undefined });
      notifyTerminal?.();
    },
    fail,
    iterate: claim,
    stream() {
      const iterator = claim();
      let cancelled = false;
      let ended = false;
      let pulling = false;
      return new ReadableStream<BrowserMessage>(
        {
          start(controller: Readonly<ReadableStreamDefaultController<BrowserMessage>>) {
            notifyTerminal = () => {
              if (cancelled || ended) return;
              if (state === 'failed') {
                ended = true;
                notifyTerminal = undefined;
                controller.error(failure);
              } else if (state === 'closing' && entries.length === 0 && !pulling) {
                ended = true;
                notifyTerminal = undefined;
                controller.close();
              }
            };
            notifyTerminal();
          },
          async pull(controller: Readonly<ReadableStreamDefaultController<BrowserMessage>>) {
            pulling = true;
            try {
              const result = await iterator.next();
              if (cancelled || ended) return;
              if (result.done === true) {
                ended = true;
                notifyTerminal = undefined;
                controller.close();
              } else controller.enqueue(result.value);
            } catch (reason) {
              if (!cancelled && !ended) {
                ended = true;
                notifyTerminal = undefined;
                controller.error(reason);
              }
            } finally {
              pulling = false;
              notifyTerminal?.();
            }
          },
          cancel() {
            cancelled = true;
            cancel();
          },
        },
        { highWaterMark: 0 },
      );
    },
    snapshot() {
      return { messages: entries.length, bytes, peakMessages, peakBytes };
    },
  };
}
