/**
 * The byte-level transport contract. The core opens a transport once per connection attempt. It creates the read side
 * first and hands it to the opener, so an end, a failure or fatal input during the open is recorded and reported once the
 * session listens. A valid packet that arrives before the session listens is dropped. A broker sends nothing before
 * CONNECT, which the session writes after it listens. The opener returns a write-only object. No object both receives
 * and writes.
 */

/**
 * What the core hands the transport. After the first `end` or `fail`, or after the core closed the transport, the calls
 * no longer reach the session.
 */
export interface ByteInbound {
  /** Bytes from the peer, split at any boundary. The core copies what it keeps, so the transport may reuse the chunk. */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views are mutable; the core copies what it keeps.
  bytes(chunk: Readonly<Uint8Array>): void;
  /** The peer finished sending, or the connection closed. */
  end(reason?: Readonly<Error>): void;
  /** The transport broke. */
  fail(error: Readonly<Error>): void;
}

export interface OpenContext {
  /** Aborted when the core gives up on this attempt. The opener then releases what it holds and rejects. */
  readonly signal: AbortSignal;
  /** The opener's own deadline for establishing the connection. */
  readonly timeoutMs: number;
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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The native layer keeps the encoded bytes by identity.
  write(chunk: Uint8Array): Promise<void>;
  /**
   * Close gracefully when `force` is false. When it is true, release the connection promptly and settle every pending
   * `write`. Allow repeated calls. Settle once closed. The core sets no close deadline of its own.
   */
  close(force: boolean): Promise<void>;
}

export interface ByteTransport {
  /**
   * Prefixes the core's own messages: `<name> write budget exceeded`, `<name> connection aborted` when the abort reason
   * is not an Error, and `<name> connection closed` when `end` gets no reason. The core needs it before a writer exists.
   */
  readonly name: string;
  /**
   * Open one connection. Settle only once the connection is usable, or once it is released. When the open rejects, the
   * core reports the first failure the transport delivered to `inbound`, and otherwise the rejection.
   */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The opener keeps the inbound object and the native abort signal by identity.
  open(inbound: ByteInbound, context: OpenContext): Promise<ByteWriter>;
}
