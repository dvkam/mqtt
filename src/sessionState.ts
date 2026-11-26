import { MqttError } from './mqttError.js';
import type { OutgoingPublication } from './publication.js';
import type { ConnectionInfo, UncertainPublication } from './session.js';
import { utf8Length } from './util/utf8.js';

const sessionStateBrand: unique symbol = Symbol('SessionState');

/**
 * The client side of an MQTT session that outlives one connection. It holds each QoS 1 publication that was written
 * and not yet acknowledged, with its Packet Identifier. Pass the same object as `sessionState` to every connection of
 * the session. When a connection sends Clean Start false and the broker answers with Session Present true, the client
 * sends the stored publications again with DUP set and their Packet Identifiers. When the broker answers with Session
 * Present false, the client drops them. Only `createSessionState` makes one, and one connection uses it at a time.
 */
export interface SessionState {
  /** A key that no caller can name, so only `createSessionState` makes a `SessionState`. */
  readonly [sessionStateBrand]: true;
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

/**
 * The session state as the core uses it. Only `bindSessionState` builds one, so a bundle that never imports
 * `createSessionState` or `createReconnectingClient` leaves this code out. A durable journal for #14 can provide the same
 * members.
 */
export interface SessionBinding {
  readonly state: SessionState;
  /** Reserve the state for one connection. Returns the release function, or undefined when another connection holds it. */
  readonly claim: () => (() => void) | undefined;
  /**
   * Continue the stored session after CONNACK. Session Present false drops the stored publications. With Session
   * Present true, returns the stored publications by Packet Identifier, in the order they were first written, or the
   * conflict that ends the connection when one of them no longer fits it.
   */
  readonly resume: (connection: Readonly<ConnectionInfo>) => MqttError | ReadonlyMap<number, OutgoingPublication>;
  /**
   * Store a copy of a new QoS 1 publication before its first write, because the caller may reuse its payload and
   * Correlation Data once the publish settles. Throws when a stored publication already holds the Packet Identifier.
   */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- prefer-readonly-parameter-types needs every member deeply read-only, and the Uint8Array payload and Correlation Data of OutgoingPublication (src/publication.ts) have mutable index signatures that no readonly type removes.
  readonly record: (publication: OutgoingPublication, messageId: number) => void;
  /** A PUBACK arrived. `resent` says whether the connection sent the publication again after a resume. */
  readonly settle: (messageId: number, reasonCode: number, resent: boolean) => void;
  /** The write budget refused a new publication before writing it, so the broker never saw it. */
  readonly forget: (messageId: number) => void;
  /** Delete every stored publication and return them. */
  readonly drop: () => readonly UncertainPublication[];
}

const bindings = new WeakMap<object, SessionBinding>();

/** Whether `value` is a Session Expiry Interval of at least `minimum` seconds. */
export function isSessionExpiryInterval(value: unknown, minimum: 0 | 1): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= 0xffff_ffff;
}

function conflict(message: string): MqttError {
  // The client ends the connection with a normal DISCONNECT, so the broker keeps the session.
  return new MqttError('ERR_MQTT_SESSION_CONFLICT', message, { reasonCode: 0 });
}

/** Bind a new in-memory store, with `events` for a reconnecting client. */
export function bindSessionState(events?: Readonly<SessionEvents>): SessionBinding {
  const publications = new Map<number, OutgoingPublication>();
  const inFlight = (): UncertainPublication[] => {
    const list: UncertainPublication[] = [];
    for (const [messageId, { topic }] of publications) list.push({ topic, messageId, acknowledged: false });
    return list;
  };
  let claimed = false;
  const state: SessionState = {
    [sessionStateBrand]: true,
    get inFlight() {
      return inFlight();
    },
  };
  const binding: SessionBinding = {
    state: Object.freeze(state),
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
    resume(connection) {
      if (!connection.sessionPresent) {
        publications.clear();
        return publications;
      }
      if (publications.size === 0) return publications;
      if (connection.maximumQos === 0) return conflict('MQTT broker no longer accepts the stored QoS 1 publications');
      const limit = connection.maximumPacketSize ?? Number.POSITIVE_INFINITY;
      for (const { topic, payloadBytes, propertyBytes, retain } of publications.values()) {
        // The size of a QoS 1 PUBLISH, counted as PublicationAdmission.reserve counts it.
        const remaining = 2 + utf8Length(topic) + 2 + propertyBytes + payloadBytes;
        let lengthBytes = 1;
        for (let value = remaining; value >= 128; value = Math.floor(value / 128)) lengthBytes++;
        if (1 + lengthBytes + remaining > limit) return conflict('Stored MQTT publication exceeds the Maximum Packet Size');
        if (retain && !connection.retainAvailable)
          return conflict('Stored MQTT publication is retained, and the broker no longer allows retained messages');
      }
      return publications;
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- prefer-readonly-parameter-types needs every member deeply read-only, and the Uint8Array payload and Correlation Data of OutgoingPublication (src/publication.ts) have mutable index signatures that no readonly type removes.
    record(publication, messageId) {
      if (publications.has(messageId))
        throw new MqttError('ERR_MQTT_SESSION_CONFLICT', 'A stored MQTT publication holds this Packet Identifier', {
          fatal: false,
        });
      const { payload, properties } = publication;
      const correlationData = properties?.correlationData;
      publications.set(messageId, {
        ...publication,
        payload: new Uint8Array(payload),
        properties:
          properties === undefined || correlationData === undefined
            ? properties
            : { ...properties, correlationData: new Uint8Array(correlationData) },
      });
    },
    settle(messageId, reasonCode, resent) {
      const topic = resent ? publications.get(messageId)?.topic : undefined;
      publications.delete(messageId);
      if (topic !== undefined) events?.resent(topic, messageId, reasonCode);
    },
    forget(messageId) {
      publications.delete(messageId);
    },
    drop() {
      const dropped = inFlight();
      publications.clear();
      return dropped;
    },
  };
  bindings.set(binding.state, binding);
  return binding;
}

/** The binding of a state that `createSessionState` made, or undefined for any other value. */
export function sessionBinding(state: unknown): SessionBinding | undefined {
  return typeof state === 'object' && state !== null ? bindings.get(state) : undefined;
}

/**
 * Create a session state that lives in memory. A restarted process starts with a new one, without the publications the
 * earlier process held.
 */
export function createSessionState(): SessionState {
  return bindSessionState().state;
}
