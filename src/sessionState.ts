import { inboundQosTwo, type InboundQosTwo } from './inboundQosTwo.js';
import { MqttError } from './mqttError.js';
import type { OutgoingPublication } from './publication.js';
import { publishSize } from './publicationAdmission.js';
import type { ConnectionInfo, UncertainPublication } from './session.js';
import { utf8Length } from './util/utf8.js';

const sessionStateBrand: unique symbol = Symbol('SessionState');

/**
 * The client side of an MQTT session that outlives one connection. It holds each QoS 1 and QoS 2 publication that was
 * written and whose exchange has not ended, with its Packet Identifier. It also holds the Packet Identifier of each
 * inbound QoS 2 publication that the application received and that the broker has not released with PUBREL, and the
 * highest QoS that the broker granted a subscription of the session. Pass the same object as `sessionState` to every
 * connection of the session. When a connection sends Clean Start false and the broker answers with Session Present true,
 * the client continues each stored exchange with its Packet Identifier. It sends PUBREL for a QoS 2 publication that has
 * its PUBREC, and the PUBLISH with DUP set for any other. The broker also delivers to the subscriptions of the session
 * again, so a connection with Clean Start false needs the handlers for the granted QoS. Without them `connect()` rejects
 * with `ERR_MQTT_INVALID_ARGUMENT` before the transport opens. When the broker answers with Session Present false, the
 * client drops everything stored. Only `createSessionState` makes one, and one connection uses it at a time.
 */
export interface SessionState {
  /** A key that no caller can name, so only `createSessionState` makes a `SessionState`. */
  readonly [sessionStateBrand]: true;
  /**
   * The stored publications, in the order a resumed session continues them. First come the QoS 2 publications that have
   * their PUBREC, in the order the PUBRECs arrived, with `acknowledged` true. The others follow in the order they were
   * first written, with `acknowledged` false. The client drops a QoS 1 publication once its PUBACK arrives, and a QoS 2
   * publication once its PUBCOMP or a refusing PUBREC arrives.
   */
  readonly inFlight: readonly UncertainPublication[];
}

/** What a connection reports to a reconnecting client about the stored publications of their shared session. */
export interface SessionEvents {
  /** The broker answered a publication that the connection continued after it resumed the session. */
  readonly resent: (kind: 'puback' | 'pubrec' | 'pubcomp', topic: string, messageId: number, reasonCode: number) => void;
}

/**
 * A stored exchange that a resumed session continues. `released` is true for a QoS 2 publication that has its PUBREC,
 * which continues with PUBREL and whose publication keeps only the topic.
 */
export type StoredExchange = readonly [messageId: number, publication: OutgoingPublication, released: boolean];

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
   * Continue the stored session after CONNACK. Session Present false drops everything stored. With Session Present true,
   * returns the stored exchanges in the order to continue them, or the conflict that ends the connection when a
   * publication no longer fits it.
   */
  readonly resume: (connection: Readonly<ConnectionInfo>) => MqttError | readonly StoredExchange[];
  /**
   * Store a copy of a new QoS 1 or QoS 2 publication before its first write, because the caller may reuse its payload
   * and Correlation Data once the publish settles. Throws instead of replacing a stored publication.
   */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- prefer-readonly-parameter-types needs every member deeply read-only, and the Uint8Array payload and Correlation Data of OutgoingPublication (src/publication.ts) have mutable index signatures that no readonly type removes.
  readonly record: (publication: OutgoingPublication, messageId: number) => void;
  /** A PUBACK arrived. `resent` says whether the connection sent the publication again after a resume. */
  readonly settle: (messageId: number, reasonCode: number, resent: boolean) => void;
  /**
   * A PUBREC arrived for a QoS 2 publication. A reason below 0x80 keeps its topic and Packet Identifier for the PUBREL
   * and drops its payload. Any other reason ends the exchange.
   */
  readonly received: (messageId: number, reasonCode: number, resent: boolean) => void;
  /** A PUBCOMP arrived, which ends the exchange of a QoS 2 publication. */
  readonly completed: (messageId: number, reasonCode: number, resent: boolean) => void;
  /** The inbound QoS 2 publications whose exchange has not ended. The connection reports each step of a delivery. */
  readonly inbound: InboundQosTwo;
  /** A SUBACK of this session granted `qos`. */
  readonly granted: (qos: 0 | 1 | 2) => void;
  /**
   * The highest QoS that a SUBACK of this session granted, so the highest QoS at which the broker delivers to the
   * subscriptions the state knows. An unsubscribe does not lower it. Session Present false resets it to 0.
   */
  readonly grantedQos: () => 0 | 1 | 2;
  /** The write budget refused a new publication before writing it, so the broker never saw it. */
  readonly forget: (messageId: number) => void;
  /** Delete every stored publication and inbound Packet Identifier, and return the publications. */
  readonly drop: () => readonly UncertainPublication[];
}

const bindings = new WeakMap<object, SessionBinding>();
const noPayload = new Uint8Array(0);

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
  // The QoS 2 publications that have their PUBREC, in the order the PUBRECs arrived (MQTT-4.6.0-4).
  const releases = new Map<number, OutgoingPublication>();
  const inbound = inboundQosTwo();
  let grantedQos: 0 | 1 | 2 = 0;
  const inFlight = (): UncertainPublication[] => {
    const list: UncertainPublication[] = [];
    for (const [messageId, { topic }] of releases) list.push({ topic, messageId, qos: 2, acknowledged: true });
    for (const [messageId, { topic, qos = 1 }] of publications) list.push({ topic, messageId, qos, acknowledged: false });
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
      const stored: StoredExchange[] = [];
      if (!connection.sessionPresent) {
        publications.clear();
        releases.clear();
        inbound.clear();
        grantedQos = 0;
        return stored;
      }
      // A PUBREL fits every Maximum Packet Size the client accepts, and no CONNACK capability applies to it.
      for (const [messageId, publication] of releases) stored.push([messageId, publication, true]);
      const limit = connection.maximumPacketSize ?? Number.POSITIVE_INFINITY;
      for (const [messageId, publication] of publications) {
        const { topic, payloadBytes, propertyBytes, retain, qos = 1 } = publication;
        if (qos > connection.maximumQos)
          return conflict('MQTT broker no longer accepts the stored QoS ' + String(qos) + ' publications');
        if (publishSize(utf8Length(topic), payloadBytes, propertyBytes, qos) > limit)
          return conflict('Stored MQTT publication exceeds the Maximum Packet Size');
        if (retain && !connection.retainAvailable)
          return conflict('Stored MQTT publication is retained, and the broker no longer allows retained messages');
        stored.push([messageId, publication, false]);
      }
      return stored;
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- prefer-readonly-parameter-types needs every member deeply read-only, and the Uint8Array payload and Correlation Data of OutgoingPublication (src/publication.ts) have mutable index signatures that no readonly type removes.
    record(publication, messageId) {
      // The client claims every stored identifier when it resumes, so no new publication can get one.
      if (publications.has(messageId) || releases.has(messageId))
        throw new Error('MQTT session state already stores Packet Identifier ' + String(messageId));
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
      if (topic !== undefined) events?.resent('puback', topic, messageId, reasonCode);
    },
    received(messageId, reasonCode, resent) {
      const publication = publications.get(messageId);
      if (publication === undefined) return;
      const { topic } = publication;
      publications.delete(messageId);
      if (reasonCode < 128)
        releases.set(messageId, {
          topic,
          payload: noPayload,
          payloadBytes: 0,
          retain: false,
          properties: undefined,
          propertyBytes: 1,
          qos: 2,
        });
      if (resent) events?.resent('pubrec', topic, messageId, reasonCode);
    },
    completed(messageId, reasonCode, resent) {
      const topic = resent ? releases.get(messageId)?.topic : undefined;
      releases.delete(messageId);
      if (topic !== undefined) events?.resent('pubcomp', topic, messageId, reasonCode);
    },
    inbound,
    granted(qos) {
      if (qos > grantedQos) grantedQos = qos;
    },
    grantedQos: () => grantedQos,
    forget(messageId) {
      publications.delete(messageId);
    },
    drop() {
      const dropped = inFlight();
      publications.clear();
      releases.clear();
      inbound.clear();
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
 * Create a session state that lives in memory. A restarted process starts with a new one, without the publications and
 * the inbound Packet Identifiers the earlier process held.
 */
export function createSessionState(): SessionState {
  return bindSessionState().state;
}
