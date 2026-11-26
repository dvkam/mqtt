import type { PublishProperties } from './publication.js';
export type SessionEnd = Readonly<{ kind: 'disconnect' }> | Readonly<{ kind: 'error'; error: Readonly<Error> }>;

export type SessionEndObserver = (event: SessionEnd) => void | Promise<void>;

/**
 * Publish options. A signal that is already aborted rejects the call before anything is sent. At QoS 1 a later abort
 * withdraws a publication that is still queued. At QoS 0 a later abort has no effect.
 */
export interface PublishOptions extends PublishProperties {
  /** 0 sends the message once without an acknowledgment. 1 waits for the broker's PUBACK. Defaults to 0. */
  qos?: 0 | 1;
  /** Cancels the publish while it is still queued. */
  signal?: AbortSignal;
}

export type SubscribeOptions = { qos?: 0 | 1 };
export interface DisconnectOptions {
  /** Wait for active QoS 1 exchanges before writing DISCONNECT. Defaults to true. */
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

export interface ClientSession {
  readonly connection: ConnectionInfo;
  subscribe(topic: string, options?: Readonly<SubscribeOptions>): Promise<SubscribeResult>;
  unsubscribe(topic: string): Promise<UnsubscribeResult>;
  /**
   * Send a PUBLISH. A string payload is sent as UTF-8. A Uint8Array payload and Correlation Data are written as given, so
   * do not change their bytes before the returned promise settles.
   */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The payload and Correlation Data are the caller's Uint8Array views, and the signal keeps its native identity.
  publish(topic: string, payload: string | Uint8Array, options?: Readonly<PublishOptions>): Promise<void>;
  ping(): Promise<void>;
  disconnect(options?: Readonly<DisconnectOptions>): Promise<void>;
}

export interface ClientFactory {
  connect(): Promise<ClientSession>;
}
import type { UserProperty } from './wireProperties.js';

export interface ConnectionInfo {
  readonly clientId: string;
  readonly sessionPresent: boolean;
  readonly receiveMaximum: number;
  readonly maximumQos: 0 | 1 | 2;
  readonly maximumPacketSize?: number;
  readonly retainAvailable: boolean;
  readonly serverKeepAlive: number;
  readonly topicAliasMaximum: number;
  readonly wildcardSubscriptionAvailable: boolean;
  readonly subscriptionIdentifiersAvailable: boolean;
  readonly sharedSubscriptionAvailable: boolean;
  readonly responseInformation?: string;
  readonly serverReference?: string;
  readonly userProperties?: readonly UserProperty[];
}

export interface SubscribeResult {
  readonly grantedQos: 0 | 1;
  readonly reasonCode: 0 | 1;
  readonly reasonString?: string;
  readonly userProperties?: readonly UserProperty[];
}

export interface UnsubscribeResult {
  readonly reasonCode: 0 | 17;
  readonly reasonString?: string;
}
