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

export function createMessageQueue(_limits: Readonly<QueueLimits>): MessageQueue {
  throw new Error('Message queue prototype is not implemented');
}
