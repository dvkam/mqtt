import type { PublishProperties } from './publication.js';
import type { ReadonlyDeep } from './util/bytes.js';
/**
 * A QoS 1 or QoS 2 publication the session had written when it ended before its publish promise settled. The publish
 * promise rejected with the session's error. Unless `acknowledged` is true, the broker may or may not have it. The client
 * continues its exchange only when a later connection with the same session state resumes the session.
 */
export interface UncertainPublication {
  /** The topic it was published to. */
  readonly topic: string;
  /** The Packet Identifier it was sent with. */
  readonly messageId: number;
  /** The QoS it was published with. */
  readonly qos: 1 | 2;
  /**
   * True when the broker accepted the publication. At QoS 1 that is a PUBACK with a reason below 0x80 that arrived before
   * the write settled. At QoS 2 it is a PUBREC with a reason below 0x80. The broker then has the message, but the
   * exchange did not finish, and a broker may wait for the PUBREL before it sends the message to subscribers. A resumed
   * session sends that PUBREL again. False when no PUBACK or PUBREC arrived, or when it refused the publication.
   */
  readonly acknowledged: boolean;
}

/**
 * Why a session ended. `uncertain` lists the QoS 1 and QoS 2 publications in flight, and is absent when there were none.
 */
export type SessionEnd =
  | Readonly<{ kind: 'disconnect' }>
  | Readonly<{ kind: 'error'; error: Readonly<Error>; uncertain?: readonly UncertainPublication[] }>;

export type SessionEndObserver = (event: SessionEnd) => void | Promise<void>;

/**
 * Publish options. A signal that is already aborted rejects the call before anything is sent. At QoS 1 and QoS 2 a later
 * abort withdraws a publication that is still queued. At QoS 0 a later abort has no effect.
 */
export interface PublishOptions extends PublishProperties {
  /**
   * 0 sends the message once without an acknowledgment. 1 waits for the broker's PUBACK. 2 waits for the PUBCOMP that ends
   * the PUBLISH, PUBREC, PUBREL and PUBCOMP exchange, and the promise rejects with `ERR_MQTT_REFUSED` when the PUBREC
   * carries a reason of 0x80 or above. Defaults to 0.
   */
  qos?: 0 | 1 | 2;
  /** Cancels the publish while it is still queued. */
  signal?: AbortSignal;
}

/** Subscribe options. */
export type SubscribeOptions = {
  /**
   * The highest QoS the broker may deliver at. 1 needs an `onQosOneMessage` handler. 2 needs `onQosTwoMessage` and
   * `onQosOneMessage`, because the broker delivers a QoS 1 publication on a QoS 2 subscription at QoS 1. Defaults to 0.
   */
  qos?: 0 | 1 | 2;
};
export interface DisconnectOptions {
  /** Wait for active QoS 1 and QoS 2 exchanges before writing DISCONNECT. Defaults to true. */
  drain?: boolean;
  /** Maximum drain time in milliseconds. Defaults to the connection's operation timeout. */
  drainTimeoutMs?: number;
  /** 0 is normal disconnection. 4 asks the broker to publish its configured Will. */
  reasonCode?: 0 | 4;
}
export type QosOneMessage<Message> = Omit<Message, 'cmd' | 'qos' | 'messageId' | 'dup'> & {
  cmd: 'publish';
  qos: 1;
  messageId: number;
  dup: boolean;
};

/**
 * A received QoS 2 PUBLISH. `messageId` is its Packet Identifier, and `dup` is true when the broker sent the PUBLISH
 * again, which it does only after a resumed session.
 */
export type QosTwoMessage<Message> = Omit<Message, 'cmd' | 'qos' | 'messageId' | 'dup'> & {
  cmd: 'publish';
  qos: 2;
  messageId: number;
  dup: boolean;
};

export interface ClientSession {
  readonly connection: ConnectionInfo;
  subscribe(topic: string, options?: Readonly<SubscribeOptions>): Promise<SubscribeResult>;
  unsubscribe(topic: string): Promise<UnsubscribeResult>;
  /**
   * Send a PUBLISH. A string payload is sent as UTF-8. A Uint8Array payload and Correlation Data are written as given, so
   * do not change their bytes before the returned promise settles.
   */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The client hands `payload` to `PacketTransport.send` inside a `ClientPacket` without a copy, and a custom transport receives that packet with a writable payload (`packetTransport` in test/types/mutable-contracts.ts). A read-only parameter type here would promise the caller more than the client can keep.
  publish(topic: string, payload: string | Uint8Array, options?: ReadonlyDeep<PublishOptions>): Promise<void>;
  ping(): Promise<void>;
  disconnect(options?: Readonly<DisconnectOptions>): Promise<void>;
}

export interface ClientFactory {
  connect(): Promise<ClientSession>;
}
import type { UserProperty } from './wireProperties.js';

/** The frozen snapshot of a successful CONNACK, with MQTT defaults for the properties the broker left out. */
export interface ConnectionInfo {
  /** The client identifier of the connection: the Assigned Client Identifier when CONNECT sent an empty one. */
  readonly clientId: string;
  /**
   * The CONNACK Session Present flag. True only after CONNECT sent Clean Start false and the broker resumed the session it
   * kept for the client identifier.
   */
  readonly sessionPresent: boolean;
  /**
   * The Session Expiry Interval in effect, in seconds: the value the broker sent in CONNACK, or else the value CONNECT
   * sent, or else 0. With 0 the broker ends the session when the connection closes.
   */
  readonly sessionExpiryInterval: number;
  /**
   * How many QoS 1 and QoS 2 publications may wait for their PUBACK or PUBCOMP at once. 65,535 when the broker sent none.
   */
  readonly receiveMaximum: number;
  /** The highest QoS the broker accepts. 2 when the broker sent none. A publish with a higher QoS rejects. */
  readonly maximumQos: 0 | 1 | 2;
  /**
   * The Maximum Packet Size the broker sent, in bytes. Absent when the broker set none. The client rejects a PUBLISH,
   * SUBSCRIBE or UNSUBSCRIBE larger than it with `ERR_MQTT_CAPACITY` before writing it.
   */
  readonly maximumPacketSize?: number;
  /** Whether the broker accepts retained messages. True when the broker sent no Retain Available. */
  readonly retainAvailable: boolean;
  /**
   * The Server Keep Alive in seconds, 0 when absent. When above 0, the client sends PINGREQ after that long without a
   * write.
   */
  readonly serverKeepAlive: number;
  /** The highest Topic Alias the broker accepts from the client, 0 when absent. The client sends no Topic Alias. */
  readonly topicAliasMaximum: number;
  /** Whether the broker accepts wildcard filters. True when absent. */
  readonly wildcardSubscriptionAvailable: boolean;
  /** Whether the broker accepts Subscription Identifiers. True when absent. */
  readonly subscriptionIdentifiersAvailable: boolean;
  /** Whether the broker accepts `$share/` filters. True when absent. */
  readonly sharedSubscriptionAvailable: boolean;
  /** The Response Information the broker sent. */
  readonly responseInformation?: string;
  /** The Server Reference the broker sent. The client does not follow it. */
  readonly serverReference?: string;
  /** The User Properties the broker sent, frozen, in wire order. */
  readonly userProperties?: readonly UserProperty[];
}

export interface SubscribeResult {
  /** The QoS the broker granted, at most the requested QoS. */
  readonly grantedQos: 0 | 1 | 2;
  /** The SUBACK reason code, equal to the granted QoS. */
  readonly reasonCode: 0 | 1 | 2;
  readonly reasonString?: string;
  readonly userProperties?: readonly UserProperty[];
}

export interface UnsubscribeResult {
  readonly reasonCode: 0 | 17;
  readonly reasonString?: string;
}
