/**
 * The byte-level transport contract. The core opens a transport once per connection attempt. It creates the read side
 * first and hands it to the opener, so an end, a failure or fatal input during the open is recorded and reported once the
 * session listens. A valid packet that arrives before the session listens is dropped. A broker sends nothing before
 * CONNECT, which the session writes after it listens. The opener returns a write-only object. No object both receives
 * and writes.
 */

import type { ReadonlyBytes } from './util/bytes.js';

/**
 * What the core hands the transport. After the first `end` or `fail`, or after the core closed the transport, the calls
 * no longer reach the session.
 */
export interface ByteInbound {
  /** Bytes from the peer, split at any boundary. The core copies what it keeps, so the transport may reuse the chunk. */
  bytes(this: void, chunk: ReadonlyBytes): void;
  /** The peer finished sending, or the connection closed. */
  end(this: void, reason?: Readonly<Error>): void;
  /** The transport broke. */
  fail(this: void, error: Readonly<Error>): void;
}

export interface OpenContext {
  /**
   * Aborted when the core gives up on this attempt. The opener then releases what it holds and rejects. An opener that
   * awaits before it listens must check `aborted` after each await, because an abort that already happened fires no event.
   */
  readonly signal: AbortSignal;
  /** The opener's own deadline for establishing the connection. */
  readonly timeoutMs: number;
  /** The validated MQTT packet limit. An adapter may use it to choose its own receive limit. */
  readonly maxPacketBytes?: number;
}

/** What the opener returns. It holds no callback. */
export interface ByteWriter {
  /** Bytes accepted but not yet flushed. The core reads it before every write to apply the write budget. */
  readonly bufferedBytes: number;
  /** Extra wire bytes that a write of `length` bytes costs, such as WebSocket framing. */
  frameOverhead?(length: number): number;
  /**
   * Hand the chunk to the native layer before returning, so writes keep their call order. Settle when the native layer
   * took it.
   */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The writer owns the chunk and may hand it to a native API that keeps it, so the parameter stays a writable `Uint8Array<ArrayBuffer>`. `WriterBytesAreWritable` in test/types/mutable-contracts.ts pins that type, and `ReadonlyBytes` would make every adapter copy or assert before `socket.write`.
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
  /**
   * Close gracefully when `force` is false. When it is true, release the connection promptly and settle every pending
   * `write`, and reject a `write` that follows. Allow repeated calls. Settle once closed. The core sets no close deadline of
   * its own.
   */
  close(force: boolean): Promise<void>;
}

export interface ByteTransport {
  /**
   * Prefixes the core's own messages: `<name> write budget exceeded`, `<name> connection aborted` when the abort reason
   * is not an Error, and `<name> connection closed` when `end` gets no reason. The core needs it before a writer exists.
   */
  readonly name: string;
  /** Whether the client may subscribe to `$share/` filters over this transport. Defaults to true. */
  readonly supportsSharedSubscriptions?: boolean;
  /** Whether the client sends the `password` option in CONNECT. Defaults to true. */
  readonly supportsPassword?: boolean;
  /**
   * Open one connection. Settle only once the connection is usable, or once it is released. When the open rejects, the
   * core reports the first failure the transport delivered to `inbound`, and otherwise the rejection.
   */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `OpenReceivesInbound` and `OpenReceivesContext` in test/types/byte-transport.ts pin these parameters to `ByteInbound` and `OpenContext`, so that a transport author reads the public names in the signature. An opener may still declare `Readonly<ByteInbound>` for its own parameter, as the adapters in src/tcpClient.ts do.
  open(inbound: ByteInbound, context: OpenContext): Promise<ByteWriter>;
}
