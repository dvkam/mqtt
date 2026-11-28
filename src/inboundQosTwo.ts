/**
 * The inbound QoS 2 publications of a session whose exchange has not ended. A Packet Identifier names a publication only
 * until its PUBREL, and the broker may then give it to another one. Each delivery to the handler therefore gets a token,
 * and the outcome of a handler changes only the entry that still has its token. A handler can settle after its
 * connection ended and after a later connection finished the exchange.
 *
 * The two phases stay apart for a journal that survives a process restart (#14). It stores a Packet Identifier at
 * `delivered` and not at `begin`, because a process that stops inside the handler has not delivered the message, and the
 * broker must send it again.
 */
export interface InboundQosTwo {
  /** The handler is about to receive the publication. Returns the token of this delivery. */
  readonly begin: (messageId: number) => number;
  /** The handler of the delivery `token` fulfilled, so the publication waits for PUBREL. */
  readonly delivered: (messageId: number, token: number) => void;
  /** The handler of the delivery `token` failed, so the next PUBLISH with the Packet Identifier is a new delivery. */
  readonly failed: (messageId: number, token: number) => void;
  /** A PUBREL ended the exchange. Returns whether the Packet Identifier named a publication. */
  readonly release: (messageId: number) => boolean;
  /**
   * `handling` while the handler runs, `delivered` once it fulfilled and until PUBREL, and undefined for a Packet
   * Identifier that names no publication.
   */
  readonly phase: (messageId: number) => 'handling' | 'delivered' | undefined;
  /** The broker started a new session, which knows none of the publications. */
  readonly clear: () => void;
}

/** The publications in memory. A session state shares one across its connections. */
export function inboundQosTwo(): InboundQosTwo {
  const handling = new Map<number, number>();
  const waiting = new Set<number>();
  let deliveries = 0;
  return {
    begin(messageId) {
      deliveries += 1;
      waiting.delete(messageId);
      handling.set(messageId, deliveries);
      return deliveries;
    },
    delivered(messageId, token) {
      if (handling.get(messageId) !== token) return;
      handling.delete(messageId);
      waiting.add(messageId);
    },
    failed(messageId, token) {
      if (handling.get(messageId) === token) handling.delete(messageId);
    },
    release(messageId) {
      const running = handling.delete(messageId);
      return waiting.delete(messageId) || running;
    },
    phase(messageId) {
      if (waiting.has(messageId)) return 'delivered';
      return handling.has(messageId) ? 'handling' : undefined;
    },
    clear() {
      handling.clear();
      waiting.clear();
    },
  };
}
