import type { OutgoingPublication } from './publication.js';
import type { UncertainPublication } from './session.js';

/**
 * The client side of an MQTT session that outlives one connection. It holds each QoS 1 publication that was written
 * and not yet acknowledged, with its Packet Identifier. Pass the same object as `sessionState` to every connection of
 * the session. When a connection sends Clean Start false and the broker answers with Session Present true, the client
 * sends the stored publications again with DUP set and their Packet Identifiers. When the broker answers with Session
 * Present false, the client drops them. Only `createSessionState` makes one, and one connection uses it at a time.
 */
export interface SessionState {
  /**
   * The stored publications, in the order they were first written. Each has `acknowledged` false, because the client
   * drops a publication once its PUBACK arrives.
   */
  readonly inFlight: readonly UncertainPublication[];
}

/** What a connection reports to a reconnecting client about the stored publications of their shared session. */
export interface SessionEvents {
  /** The broker answered a publication that the connection sent again after it resumed the session. */
  readonly resent: (topic: string, messageId: number, reasonCode: number) => void;
}

/** Where connections keep their QoS 1 publications between the first write and the PUBACK. */
export interface SessionStore {
  /** Reserve the store for one connection. Returns the release function, or undefined when another connection holds it. */
  readonly claim: () => (() => void) | undefined;
  /**
   * The stored publications by Packet Identifier, in the order they were first written. A connection adds a copy of a
   * publication before its first write and deletes it once its PUBACK arrives.
   */
  readonly publications: Map<number, OutgoingPublication>;
  /** Delete every stored publication and return them. */
  readonly drop: () => readonly UncertainPublication[];
}

/** A session state as a connection uses it. */
export interface SessionBinding {
  readonly store: SessionStore;
  readonly events: SessionEvents | undefined;
}

const bindings = new WeakMap<object, SessionBinding>();

/** Bind a new in-memory store, with `events` for a reconnecting client. */
export function bindSessionState(events?: Readonly<SessionEvents>): { readonly state: SessionState } & SessionBinding {
  const publications = new Map<number, OutgoingPublication>();
  const inFlight = (): UncertainPublication[] => {
    const list: UncertainPublication[] = [];
    for (const [messageId, { topic }] of publications) list.push({ topic, messageId, acknowledged: false });
    return list;
  };
  let claimed = false;
  const store: SessionStore = {
    claim() {
      if (claimed) return undefined;
      claimed = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        claimed = false;
      };
    },
    publications,
    drop() {
      const dropped = inFlight();
      publications.clear();
      return dropped;
    },
  };
  const state: SessionState = Object.freeze({
    get inFlight() {
      return inFlight();
    },
  });
  const binding = { store, events };
  bindings.set(state, binding);
  return { state, ...binding };
}

/** The binding of a state that `createSessionState` made, or undefined for any other value. */
export function sessionBinding(state: unknown): SessionBinding | undefined {
  return typeof state === 'object' && state !== null ? bindings.get(state) : undefined;
}

/**
 * Create an in-memory session state. It lives as long as the process, so a restarted process starts without the
 * publications it held.
 */
export function createSessionState(): SessionState {
  return bindSessionState().state;
}
