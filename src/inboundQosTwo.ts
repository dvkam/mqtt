/**
 * The inbound QoS 2 publications of a session whose exchange has not ended. A Packet Identifier names a publication only
 * until its PUBREL, and the broker may then give it to another one. Each delivery to the handler therefore gets a token,
 * and the outcome of a handler changes only the entry that still has its token. A handler can settle after its
 * connection ended, and a later connection of the session then waits for its outcome before it answers the publication.
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
  /**
   * A PUBREL arrived. `released` says it ended the exchange of a publication that waited for it. `handling` says the
   * handler still runs, so the client has sent no PUBREC, and the record stays as it is. Undefined says the Packet
   * Identifier names no publication.
   */
  readonly release: (messageId: number) => 'released' | 'handling' | undefined;
  /**
   * `handling` while the handler runs, `delivered` once it fulfilled and until PUBREL, and undefined for a Packet
   * Identifier that names no publication.
   */
  readonly phase: (messageId: number) => 'handling' | 'delivered' | undefined;
  /**
   * The outcome of the delivery that runs under `messageId`: true once its handler fulfilled, false once it failed. The
   * connection that got the PUBLISH again waits for it when an earlier connection started the handler. One connection
   * uses the record at a time, so a later call replaces the wait of a connection that ended. That wait never settles,
   * and neither does one whose delivery `clear` removed.
   */
  readonly outcome: (messageId: number) => Promise<boolean>;
  /** The broker started a new session, which knows none of the publications. */
  readonly clear: () => void;
}

/** The publications in memory. A session state shares one across its connections. */
export function inboundQosTwo(): InboundQosTwo {
  const handling = new Map<number, number>();
  const waiting = new Set<number>();
  let deliveries = 0;
  // The token of the delivery whose outcome a connection waits for, and the function that tells it. A token is never 0
  // and names one delivery, which settles once.
  let awaited = 0;
  let settle: (fulfilled: boolean) => void = () => {};
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
      if (awaited === token) settle(true);
    },
    failed(messageId, token) {
      if (handling.get(messageId) !== token) return;
      handling.delete(messageId);
      if (awaited === token) settle(false);
    },
    release(messageId) {
      if (waiting.delete(messageId)) return 'released';
      return handling.has(messageId) ? 'handling' : undefined;
    },
    phase(messageId) {
      if (waiting.has(messageId)) return 'delivered';
      return handling.has(messageId) ? 'handling' : undefined;
    },
    async outcome(messageId) {
      awaited = handling.get(messageId) ?? 0;
      return new Promise<boolean>((resolve) => {
        settle = resolve;
      });
    },
    clear() {
      handling.clear();
      waiting.clear();
    },
  };
}
