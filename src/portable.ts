import { notifyObserver, packetReceiver, packetSender, type DiagnosticObserver } from './diagnostics.js';
import { endingFailure, invalidOption, MqttError, transportFailure } from './mqttError.js';
import { ProtocolInputError } from './protocolInputError.js';
import type { PublishMessage } from './messageProperties.js';
import type { BrokerPacket, ClientPacket } from './wireCodec.js';
import type {
  ClientSession,
  ConnectionInfo,
  DisconnectOptions,
  PublishOptions,
  QosOneMessage,
  QosTwoMessage,
  SessionEnd,
  SessionEndObserver,
  SubscribeOptions,
  SubscribeResult,
  UncertainPublication,
  UnsubscribeResult,
} from './session.js';
import { validateTopic, validateTopicName } from './util/validateTopic.js';
import { resolveTimeout } from './timeout.js';
import { isAbortSignal } from './util/signal.js';
import { capturePublication, type OutgoingPublication } from './publication.js';
import { PublicationAdmission, type PublicationLimits } from './publicationAdmission.js';
import { SubscriptionExchanges, type SubscriptionLimits } from './subscriptionExchanges.js';
import { PacketIdentifiers } from './packetIdentifiers.js';
import { OutboundPublications, type Resumed } from './outboundPublications.js';
import { QosZeroWrites } from './qosZeroWrites.js';
import { isPubackReason } from './pubackReason.js';
import { takeNativeBudgetFailure } from './nativeWriteBudget.js';
import type { WillMessage } from './will.js';
import { copyUserProperties } from './userProperties.js';
import type { SessionBinding } from './sessionState.js';

export type { ClientDiagnostic, DiagnosticObserver } from './diagnostics.js';
export type { SessionEnd, SessionEndObserver } from './session.js';
export { ProtocolInputError } from './protocolInputError.js';
export type { ProtocolInputCode } from './protocolInputError.js';
export type { BrokerPacket, ClientPacket } from './wireCodec.js';
export type { MessageProperties, PublishMessage } from './messageProperties.js';
export type { QosOneMessage, QosTwoMessage } from './session.js';

/** What a transport delivers: the codec's broker packets and received messages with `Bytes` payloads. */
export type ReceivedPacket<Bytes extends Uint8Array = Uint8Array> =
  | Exclude<BrokerPacket, { cmd: 'publish' }>
  | PublishMessage<Bytes>
  | QosOneMessage<PublishMessage<Bytes>>
  | QosTwoMessage<PublishMessage<Bytes>>;

type AcknowledgedMessage<Bytes extends Uint8Array> = QosOneMessage<PublishMessage<Bytes>> | QosTwoMessage<PublishMessage<Bytes>>;
type QosTwoControl = Extract<BrokerPacket, { cmd: 'pubrec' | 'pubrel' | 'pubcomp' }>;

export interface PacketTransport<Bytes extends Uint8Array = Uint8Array> {
  /** Whether this adapter can encode shared filters. Broker capabilities are separate. */
  readonly supportsSharedSubscriptions?: boolean;
  /** Write `packet`. The built-in adapters record a write-budget refusal against this same object. */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  send(packet: ClientPacket): Promise<void>;
  listen(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Custom transport packet fields are writable. test/types/mutable-contracts.ts checks the emitted declaration.
    onPacket: (packet: ReceivedPacket<Bytes>) => void,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Custom transport error callbacks can write Error.message. test/types/mutable-contracts.ts checks the emitted declaration.
    onClose: (error: Error) => void,
    /** Report a decoder rejection while the transport can still write DISCONNECT. */
    onProtocolError?: (error: Readonly<ProtocolInputError>) => void,
  ): () => void;
  /** Forced closure must promptly release pending I/O and settle. */
  close(force?: boolean): Promise<void>;
}

export interface PortableOptions<Bytes extends Uint8Array = Uint8Array> extends PublicationLimits, SubscriptionLimits {
  clientId: string;
  username?: string;
  password?: Uint8Array;
  will?: WillMessage;
  /** Defaults to true. */
  cleanStart?: boolean;
  /** Seconds, sent as the CONNECT Session Expiry Interval when set. */
  sessionExpiryInterval?: number;
  /** The state that keeps unfinished QoS 1 and QoS 2 exchanges across connections, claimed for this connection. */
  session?: SessionBinding;
  /** Releases the claim on `session`. The client calls it when the connection ends. */
  releaseSession?: () => void;
  timeoutMs?: number;
  onDiagnostic?: DiagnosticObserver;
  onSessionEnd?: SessionEndObserver;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Delivery preserves the adapter's mutable byte buffer type.
  onMessage?: (packet: PublishMessage<Bytes>) => void;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Delivery preserves the adapter's mutable byte buffer type.
  onQosOneMessage?: (packet: QosOneMessage<PublishMessage<Bytes>>) => void | Promise<void>;
  /**
   * Receives each inbound QoS 2 publication once. The client sends PUBREC after the handler returns or its promise
   * fulfills. A handler that throws or rejects ends the session without PUBREC.
   */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Developer experience: a deeply readonly message would type `payload` as a read-only view, so a handler that passes it to an API that takes a Buffer or Uint8Array would need a copy or a type assertion. The onQosTwoMessage handler in test/types/mutable-contracts.ts assigns the payload.
  onQosTwoMessage?: (packet: QosTwoMessage<PublishMessage<Bytes>>) => void | Promise<void>;
}

/**
 * What holds the one inbound receive slot. `handling` runs a handler. `acknowledging` writes the PUBACK or PUBCOMP that
 * frees the slot at the broker, so one next publication may already arrive. `releasing` has sent PUBREC for a QoS 2
 * publication and waits for its PUBREL.
 */
type InboundPhase = 'handling' | 'acknowledging' | 'releasing';
type DeadlineOwner = 'operation' | 'inbound-publish' | 'outbound-publish' | 'auto-ping';

function disconnectReason(value: unknown): DisconnectOptions['reasonCode'] {
  if (value === undefined || value === 0 || value === 4) return value;
  throw new RangeError('Unsupported MQTT disconnect reason code');
}

function connackRefusal(
  { reasonCode, reasonString, userProperties }: Readonly<Pick<Connack, 'reasonCode' | 'reasonString' | 'userProperties'>>,
  hasWill: boolean,
): MqttError {
  let message = 'MQTT acknowledgment refused';
  if (hasWill && reasonCode === 0x9a) message = 'MQTT broker does not support a retained Will';
  if (hasWill && reasonCode === 0x9b) message = 'MQTT broker does not support the requested Will QoS';
  return new MqttError('ERR_MQTT_REFUSED', message, { reasonCode, reasonString, userProperties });
}
type Connack = Extract<BrokerPacket, { cmd: 'connack' }>;
type Acknowledgment =
  | Readonly<{ cmd: 'connack'; connection: ConnectionInfo }>
  | Readonly<{ cmd: 'connack'; error: string }>
  | Readonly<{ cmd: 'pingresp' }>;

interface KeepAlive {
  readonly intervalMs: number;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** A QoS 0 publication that waits for the resends. */
interface WaitingWrite {
  readonly write: () => void;
  readonly fail: (error: Readonly<Error>) => void;
}

class PortableClient<Bytes extends Uint8Array> {
  private readonly transport: PacketTransport<Bytes>;
  private sendPacket: PacketTransport<Bytes>['send'];
  private readonly onDiagnostic: DiagnosticObserver | undefined;
  private readonly onSessionEnd: SessionEndObserver | undefined;
  private readonly options: PortableOptions<Bytes>;
  private readonly clientId: string;
  private readonly will: WillMessage | undefined;
  private readonly cleanStart: boolean;
  private readonly session: SessionBinding | undefined;
  private readonly releaseSession: (() => void) | undefined;
  private resending?: Promise<unknown>;
  // Set while resends are unwritten: `unwritten` counts them, and `waiting` holds the QoS 0 publications that wait for
  // them. New QoS 1 and QoS 2 publications wait in the OutboundPublications queue instead.
  private resendPhase?: { readonly waiting: WaitingWrite[]; unwritten: number };
  // Set once DISCONNECT is about to be written or the session ended. No resend or waiting write goes out after it.
  private writesEnded?: Error;
  private pendingAck?: (packet: Acknowledgment) => void;
  private keepAlive?: KeepAlive;
  private automaticPing?: Promise<void>;
  private readonly pendingOperations = new Set<(error: Readonly<Error>) => void>();
  private failure?: Error;
  private closing?: Promise<void>;
  private drainingPublications = false;
  private forcedClose?: Promise<void>;
  private readonly unlisten: (() => void) | undefined;
  private readonly subscriptions: SubscriptionExchanges;
  private readonly identifiers = new PacketIdentifiers();
  private outbound?: OutboundPublications<OutgoingPublication>;
  private activation: 'opening' | 'accepted' | 'active' = 'opening';
  private retainAvailable = true;
  private maximumQos: 0 | 1 | 2 = 2;
  private connackReceived = false;
  private inboundPhase?: InboundPhase;
  private nextInbound?: AcknowledgedMessage<Bytes>;
  // The Packet Identifier of the inbound QoS 2 publication that holds the receive slot.
  private inboundExchange?: number;
  // The inbound QoS 2 Packet Identifiers that the handler received and that wait for PUBREL. A session state shares its
  // own set, so the identifiers outlive the connection.
  private delivered?: Set<number>;
  private readonly onQosOneMessage: PortableOptions<Bytes>['onQosOneMessage'];
  private readonly onQosTwoMessage: PortableOptions<Bytes>['onQosTwoMessage'];
  private readonly timeoutMs: number;
  private readonly publications: PublicationAdmission;
  private readonly qosZeroWrites: QosZeroWrites;

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  constructor(transport: PacketTransport<Bytes>, options: PortableOptions<Bytes>) {
    this.timeoutMs = resolveTimeout(options.timeoutMs);
    this.publications = new PublicationAdmission(options);
    this.qosZeroWrites = new QosZeroWrites(this.timeoutMs, () => {
      void this.abort(new MqttError('ERR_MQTT_TIMEOUT', 'MQTT operation timed out')).catch(() => {});
    });
    this.subscriptions = new SubscriptionExchanges(options, this.identifiers);
    this.transport = transport;
    this.onDiagnostic = options.onDiagnostic;
    this.onSessionEnd = options.onSessionEnd;
    this.sendPacket = packetSender(transport, this.onDiagnostic);
    this.options = options;
    this.clientId = options.clientId;
    this.will = options.will;
    this.cleanStart = options.cleanStart ?? true;
    this.session = options.session;
    this.releaseSession = options.releaseSession;
    this.onQosOneMessage = options.onQosOneMessage;
    this.onQosTwoMessage = options.onQosTwoMessage;
    this.delivered = options.session?.inbound;
    this.unlisten = transport.listen(
      packetReceiver(
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
        (packet: ReceivedPacket<Bytes>) => {
          if (this.failure) return;
          if (packet.cmd === 'connack') {
            try {
              this.receiveConnack(packet);
            } catch (cause) {
              void this.abort(
                cause instanceof Error ? cause : new MqttError('ERR_MQTT_PROTOCOL', 'Invalid MQTT connection metadata', { cause }),
              ).catch(() => {});
            }
            return;
          }
          if (packet.cmd === 'disconnect') {
            void this.abort(
              new MqttError('ERR_MQTT_BROKER_DISCONNECT', 'MQTT broker disconnected', {
                reasonCode: packet.reasonCode ?? 0,
                reasonString: packet.reasonString,
                userProperties: packet.userProperties,
              }),
            ).catch(() => {});
            return;
          }
          if (packet.cmd === 'suback' || packet.cmd === 'unsuback') {
            try {
              const code = this.subscriptions.accept(packet);
              if (code !== undefined)
                this.rejectProtocolInput(new ProtocolInputError('Invalid MQTT subscription acknowledgment', code));
            } catch (cause) {
              void this.abort(
                cause instanceof Error
                  ? cause
                  : new MqttError('ERR_MQTT_PROTOCOL', 'Invalid MQTT subscription metadata', { cause }),
              ).catch(() => {});
            }
            return;
          }
          if (packet.cmd === 'puback') {
            const { messageId, reasonCode: code } = packet;
            if (!Number.isInteger(messageId) || messageId < 1 || messageId > 65_535) {
              void this.abort(new MqttError('ERR_MQTT_PROTOCOL', 'Invalid PUBACK packet identifier')).catch(() => {});
              return;
            }
            if (!isPubackReason(code)) {
              void this.abort(new MqttError('ERR_MQTT_PROTOCOL', 'Invalid PUBACK reason code')).catch(() => {});
              return;
            }
            const matched = this.outbound?.accept(messageId, code);
            if (matched !== undefined) this.session?.settle(messageId, code, matched === 'resent');
            return;
          }
          if (packet.cmd === 'pingresp') this.pendingAck?.(packet);
          if (packet.cmd !== 'publish') {
            if (packet.cmd === 'pubrec' || packet.cmd === 'pubrel' || packet.cmd === 'pubcomp') this.receiveQosTwoControl(packet);
            return;
          }
          if (this.closing) return;
          if (packet.qos === 0) {
            if (this.activation !== 'opening') options.onMessage?.(packet);
            return;
          }
          if (packet.qos === 1 ? this.onQosOneMessage : this.onQosTwoMessage) {
            const { messageId, dup } = packet;
            if (!Number.isInteger(messageId) || messageId < 1 || messageId > 65_535 || typeof dup !== 'boolean') {
              void this.abort(new MqttError('ERR_MQTT_PROTOCOL', 'Invalid inbound QoS ' + String(packet.qos) + ' PUBLISH')).catch(
                () => {},
              );
              return;
            }
            this.receiveAcknowledged({ ...packet, messageId, dup });
          }
        },
        this.onDiagnostic,
        () => this.failure === undefined,
      ),
      (error: Readonly<Error>) => {
        this.fail(error);
      },
      this.rejectProtocolInput.bind(this),
    );
    if (this.failure) {
      try {
        this.unlisten();
      } catch {
        // A synchronous close already owns the opening result.
      }
    }
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The decoded packet retains the original authentication byte view.
  private receiveConnack(packet: Readonly<Connack>): void {
    if (this.connackReceived) {
      this.rejectProtocolInput(new ProtocolInputError('Duplicate MQTT CONNACK', 0x82));
      return;
    }
    this.connackReceived = true;
    if (packet.sessionPresent && (this.cleanStart || packet.reasonCode !== 0)) {
      this.rejectProtocolInput(new ProtocolInputError('Unexpected MQTT Session Present', 0x82));
      return;
    }
    const { authenticationMethod, authenticationData } = packet;
    if (authenticationMethod !== undefined || authenticationData !== undefined) {
      this.rejectProtocolInput(new ProtocolInputError('Unexpected MQTT authentication properties', 0x82));
      return;
    }
    const { reasonCode } = packet;
    const pending = this.pendingAck;
    if (reasonCode !== 0) {
      if (pending !== undefined) this.fail(connackRefusal(packet, this.will !== undefined));
      return;
    }
    const { assignedClientIdentifier } = packet;
    if (
      (this.clientId === '' && assignedClientIdentifier === undefined) ||
      (assignedClientIdentifier !== undefined &&
        (typeof assignedClientIdentifier !== 'string' ||
          assignedClientIdentifier.length === 0 ||
          assignedClientIdentifier.length > 65_535 ||
          /[\uD800-\uDFFF]/u.test(assignedClientIdentifier) ||
          assignedClientIdentifier.includes('\u0000') ||
          new TextEncoder().encode(assignedClientIdentifier).byteLength > 65_535 ||
          (this.clientId !== '' && assignedClientIdentifier !== this.clientId)))
    ) {
      this.rejectProtocolInput(new ProtocolInputError('Invalid MQTT Assigned Client Identifier', 0x82));
      return;
    }
    if (pending === undefined || this.failure !== undefined) return;
    const { receiveMaximum = 65_535, maximumQoS } = packet;
    if (!Number.isInteger(receiveMaximum) || receiveMaximum < 1 || receiveMaximum > 65_535) {
      pending({ cmd: 'connack', error: 'Invalid broker Receive Maximum' });
      return;
    }
    if (maximumQoS !== undefined && maximumQoS !== 0 && maximumQoS !== 1) {
      pending({ cmd: 'connack', error: 'Invalid broker Maximum QoS' });
      return;
    }
    const { maximumPacketSize } = packet;
    // The client's PUBACK takes 4 bytes, and MQTT-3.2.2-15 forbids sending a packet over the limit.
    if (maximumPacketSize !== undefined && maximumPacketSize < 4) {
      pending({ cmd: 'connack', error: 'Unsupported broker Maximum Packet Size' });
      return;
    }
    const {
      sessionPresent,
      sessionExpiryInterval = this.options.sessionExpiryInterval ?? 0,
      retainAvailable = true,
      serverKeepAlive = 0,
      topicAliasMaximum = 0,
      wildcardSubscriptionAvailable = true,
      subscriptionIdentifiersAvailable = true,
      sharedSubscriptionAvailable = true,
      responseInformation,
      serverReference,
      userProperties: properties,
    } = packet;
    const userProperties = copyUserProperties(properties);
    // oxlint-disable-next-line typescript/no-unnecessary-condition, typescript/strict-boolean-expressions -- Metadata getters on the decoded seam can retire the session during capture.
    if (this.failure) return;
    const connection = Object.freeze({
      clientId: assignedClientIdentifier ?? this.clientId,
      sessionPresent,
      sessionExpiryInterval,
      receiveMaximum,
      maximumQos: maximumQoS ?? 2,
      retainAvailable,
      serverKeepAlive,
      topicAliasMaximum,
      wildcardSubscriptionAvailable,
      subscriptionIdentifiersAvailable,
      sharedSubscriptionAvailable,
      ...(maximumPacketSize === undefined ? {} : { maximumPacketSize }),
      ...(responseInformation === undefined ? {} : { responseInformation }),
      ...(serverReference === undefined ? {} : { serverReference }),
      ...(userProperties === undefined ? {} : { userProperties }),
    });
    this.activation = 'accepted';
    pending({ cmd: 'connack', connection });
  }

  async open(): Promise<ConnectionInfo> {
    let connectSentAt = 0;
    const reply = await this.exchange(
      {
        cmd: 'connect',
        clientId: this.clientId,
        cleanStart: this.cleanStart,
        keepAlive: 0,
        ...(this.options.sessionExpiryInterval === undefined ? {} : { sessionExpiryInterval: this.options.sessionExpiryInterval }),
        username: this.options.username,
        password: this.options.password,
        ...(this.will === undefined ? {} : { will: this.will }),
        ...(this.onQosOneMessage || this.onQosTwoMessage ? { receiveMaximum: 1 } : {}),
      },
      (ack) => ack.cmd === 'connack',
      {
        onSent: () => {
          connectSentAt = performance.now();
        },
      },
    );
    if (this.failure) throw this.failure;
    if (reply.cmd !== 'connack') throw new MqttError('ERR_MQTT_PROTOCOL', 'Expected CONNACK');
    if ('error' in reply) throw new MqttError('ERR_MQTT_PROTOCOL', reply.error);
    const { connection } = reply;
    const { receiveMaximum, maximumQos, serverKeepAlive } = connection;
    this.retainAvailable = connection.retainAvailable;
    this.maximumQos = maximumQos;
    if (connection.maximumPacketSize !== undefined) {
      this.publications.limitPacketSize(connection.maximumPacketSize);
      this.subscriptions.limitPacketSize(connection.maximumPacketSize);
    }
    // A broker with Maximum QoS 0 still gets the PUBREL of a stored QoS 2 exchange that has its PUBREC.
    const outbound = new OutboundPublications<OutgoingPublication>(
      receiveMaximum,
      this.identifiers,
      this.transmitter(false),
      this.releasePublication.bind(this),
      isQosTwo,
      this.session?.record,
    );
    this.outbound = outbound;
    const resumed = this.session?.resume(connection);
    if (resumed instanceof MqttError) {
      await this.abort(resumed, 0);
      throw resumed;
    }
    if (resumed !== undefined && resumed.length > 0) {
      const resends: Resumed<OutgoingPublication>[] = [];
      for (const [messageId, publication, released] of resumed) {
        const identifier = this.identifiers.claim(messageId);
        if (publication.qos === undefined) resends.push([publication, identifier]);
        else resends.push([publication, identifier, released ? 'release' : 'publish']);
      }
      this.resendPhase = { waiting: [], unwritten: resends.length };
      outbound.resume(resends, this.transmitter(true));
    }
    this.activation = 'active';
    if (serverKeepAlive > 0) this.startKeepAlive(serverKeepAlive * 1000, connectSentAt);
    this.advanceInbound();
    const interrupted = this.reportConnection('active');
    if (interrupted) throw interrupted;
    return connection;
  }

  changeSubscription(topic: string, command: 'subscribe', qos?: number): Promise<SubscribeResult>;
  changeSubscription(topic: string, command: 'unsubscribe'): Promise<UnsubscribeResult>;
  async changeSubscription(
    topic: string,
    command: 'subscribe' | 'unsubscribe',
    qos = 0,
  ): Promise<SubscribeResult | UnsubscribeResult> {
    if (this.closing) throw closingError();
    if (this.failure) throw this.failure;
    if (!validateTopic(topic)) throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'Invalid MQTT topic filter');
    if (this.transport.supportsSharedSubscriptions === false && topic.startsWith('$share/'))
      throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'Unsupported shared subscription');
    if (qos !== 0 && qos !== 1 && qos !== 2) throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'Unsupported MQTT subscription QoS');
    if (qos === 1 && !this.onQosOneMessage)
      throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'QoS 1 subscription requires onQosOneMessage');
    // The broker delivers a QoS 1 publication on a QoS 2 subscription at QoS 1 (MQTT 5 section 3.8.4).
    if (qos === 2 && !(this.onQosTwoMessage && this.onQosOneMessage))
      throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'QoS 2 subscription requires onQosTwoMessage and onQosOneMessage');
    const subscribing = command === 'subscribe';
    const reservation = this.subscriptions.reserve(topic, subscribing ? 'suback' : 'unsuback', qos);
    const { messageId } = reservation;
    const packet: ClientPacket = subscribing
      ? { cmd: 'subscribe', messageId, topics: [topic], qos }
      : { cmd: 'unsubscribe', messageId, topics: [topic] };
    return this.run(async () => {
      try {
        const sent = this.sendIdentified(packet, subscribing ? 'MQTT subscription send failed' : 'MQTT unsubscribe send failed');
        const [{ reasonCode, reasonString, userProperties }] = await Promise.all([reservation.acknowledged, sent]);
        const details = reasonString === undefined ? {} : { reasonString };
        if (subscribing && (reasonCode === 0 || reasonCode === 1 || reasonCode === 2) && reasonCode <= qos) {
          return { grantedQos: reasonCode, reasonCode, ...details, ...(userProperties === undefined ? {} : { userProperties }) };
        }
        if (!subscribing && (reasonCode === 0 || reasonCode === 17)) return { reasonCode, ...details };
        throw new MqttError('ERR_MQTT_REFUSED', 'MQTT acknowledgment refused', { reasonCode, fatal: false });
      } finally {
        reservation.release();
      }
    });
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The handler receives the adapter's mutable packet payload.
  private receiveAcknowledged(packet: AcknowledgedMessage<Bytes>): void {
    if (this.activation === 'opening') {
      void this.abort(
        new MqttError('ERR_MQTT_PROTOCOL', 'Inbound QoS ' + String(packet.qos) + ' PUBLISH arrived before CONNACK'),
      ).catch(() => {});
      return;
    }
    // The session state says which Packet Identifiers wait for PUBREL only once the session is active.
    if (packet.qos === 2 && this.activation === 'active' && this.delivered?.has(packet.messageId) === true) {
      // MQTT-4.3.3-10: the PUBLISH is a duplicate until PUBREL, so it gets PUBREC again and no second delivery. While its
      // handler still runs, the PUBREC that follows the handler answers it.
      if (this.inboundExchange !== packet.messageId || this.inboundPhase !== 'handling')
        this.answer({ cmd: 'pubrec', messageId: packet.messageId, reasonCode: 0 });
      return;
    }
    const canWait = this.activation === 'accepted' || this.inboundPhase === 'acknowledging';
    if (canWait && !this.nextInbound) {
      this.nextInbound = packet;
      return;
    }
    if (canWait || this.inboundPhase) {
      void this.abort(new MqttError('ERR_MQTT_PROTOCOL', 'MQTT Receive Maximum exceeded', { reasonCode: 0x93 }), 0x93).catch(
        () => {},
      );
      return;
    }
    this.inboundPhase = 'handling';
    if (packet.qos === 1) void this.deliverQosOne(packet);
    else void this.deliverQosTwo(packet);
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Preserve the mutable application payload while keeping the ACK identifier private.
  private async deliverQosOne(packet: QosOneMessage<PublishMessage<Bytes>>): Promise<void> {
    const { messageId } = packet;
    try {
      await this.run(async () => {
        await this.onQosOneMessage?.(packet);
        if (this.failure || this.closing) return;
        this.inboundPhase = 'acknowledging';
        await this.sendPacket({ cmd: 'puback', messageId, reasonCode: 0 });
      }, 'inbound-publish');
    } catch (reason) {
      this.failInbound(reason);
    } finally {
      this.inboundPhase = undefined;
      this.advanceInbound();
    }
  }

  /**
   * Deliver a QoS 2 publication once, then send PUBREC. The Packet Identifier is recorded before the handler runs, so a
   * duplicate PUBLISH never starts a second delivery. A handler that fails removes it again, so the next PUBLISH with that
   * Packet Identifier is delivered.
   */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Performance: PortableOptions.onQosTwoMessage takes a writable message, so a readonly parameter here could reach the handler only through a copy of the message or a closure per delivery. 'a handler that changes messageId does not change the PUBREC' in test/qos2-inbound.test.ts covers the identifier.
  private async deliverQosTwo(packet: QosTwoMessage<PublishMessage<Bytes>>): Promise<void> {
    const { messageId } = packet;
    const delivered = (this.delivered ??= new Set());
    delivered.add(messageId);
    this.inboundExchange = messageId;
    let acknowledged = false;
    try {
      acknowledged = await this.run(async () => {
        try {
          await this.onQosTwoMessage?.(packet);
        } catch (reason) {
          // The handler can settle after the session ended, so its own outcome decides, not the end of this operation.
          delivered.delete(messageId);
          throw reason;
        }
        if (this.failure || this.closing) return false;
        this.inboundPhase = 'releasing';
        await this.sendPacket({ cmd: 'pubrec', messageId, reasonCode: 0 });
        return true;
      }, 'inbound-publish');
    } catch (reason) {
      this.failInbound(reason);
    } finally {
      // After PUBREC the publication keeps the receive slot until its PUBREL arrives.
      if (!acknowledged) {
        this.inboundExchange = undefined;
        this.inboundPhase = undefined;
        this.advanceInbound();
      }
    }
  }

  /** A handler that failed, or an acknowledgment that could not be written, ends the session. */
  private failInbound(reason: unknown): void {
    if (!this.failure && !this.closing)
      void this.abort(reason instanceof Error ? endingFailure(reason) : new Error('MQTT inbound delivery failed')).catch(() => {});
  }

  private advanceInbound(): void {
    const next = this.nextInbound;
    this.nextInbound = undefined;
    if (next && !this.failure && !this.closing) this.receiveAcknowledged(next);
  }

  /** PUBREC and PUBCOMP continue an outbound QoS 2 exchange. PUBREL ends an inbound one. */
  private receiveQosTwoControl(packet: Readonly<QosTwoControl>): void {
    const { cmd, messageId, reasonCode: code } = packet;
    if (cmd === 'pubrel') {
      this.receiveRelease(messageId);
      return;
    }
    if (cmd === 'pubcomp') {
      const matched = this.outbound?.completed(messageId, code);
      if (matched !== undefined) this.session?.completed(messageId, code, matched === 'resent');
      return;
    }
    const matched = this.outbound?.received(messageId, code);
    if (matched === undefined) {
      // MQTT-4.3.3-4 asks for a PUBREL after each accepting PUBREC. For a Packet Identifier without an exchange it
      // carries Packet Identifier not found, so the broker can drop what it holds. A graceful close answers nothing,
      // because the drain deadline may just have dropped an exchange that the session state keeps for a resume.
      if (code < 128 && this.activation === 'active' && !this.closing)
        this.answer({ cmd: 'pubrel', messageId, reasonCode: this.unknownIdentifierReason() });
    } else if (matched !== 'ignored') this.session?.received(messageId, code, matched === 'resent');
  }

  /** MQTT-4.3.3-11: every PUBREL gets a PUBCOMP. It frees the Packet Identifier, and the receive slot when it held it. */
  private receiveRelease(messageId: number): void {
    // A graceful close writes nothing more for inbound publications. The Packet Identifier stays for a resumed session.
    if (this.closing || this.activation === 'opening') return;
    if (this.inboundExchange === messageId && this.inboundPhase === 'handling') {
      this.rejectProtocolInput(new ProtocolInputError('MQTT PUBREL arrived before PUBREC', 0x82));
      return;
    }
    if (this.delivered?.delete(messageId) !== true) {
      this.answer({ cmd: 'pubcomp', messageId, reasonCode: this.unknownIdentifierReason() });
      return;
    }
    if (this.inboundExchange !== messageId) {
      this.answer({ cmd: 'pubcomp', messageId, reasonCode: 0 });
      return;
    }
    this.inboundExchange = undefined;
    this.inboundPhase = 'acknowledging';
    this.answer({ cmd: 'pubcomp', messageId, reasonCode: 0 }, true);
  }

  /**
   * Reason code 0x92, Packet Identifier not found, takes a fifth byte. A broker whose Maximum Packet Size is 4 gets the
   * four-byte form without a reason code, because MQTT-3.2.2-15 forbids a larger packet.
   */
  private unknownIdentifierReason(): 0 | 0x92 {
    return this.publications.packetLimit < 5 ? 0 : 0x92;
  }

  /**
   * Answer a packet that just arrived with a PUBREC, PUBREL or PUBCOMP. The write starts on the next microtask, because
   * a transport may deliver a packet from inside its own write call and the packet input does not take bytes while it
   * handles one. The callers answer nothing once `disconnect()` was called. A failed write ends the session.
   * `freesSlot` marks the PUBCOMP that ends the publication in the receive slot, so the retained next PUBLISH starts once
   * the write settled.
   */
  private answer(packet: Readonly<Extract<ClientPacket, { cmd: 'pubrec' | 'pubrel' | 'pubcomp' }>>, freesSlot = false): void {
    void this.run(async () => {
      await Promise.resolve();
      await this.sendPacket(packet);
    }, 'inbound-publish')
      .catch(this.failInbound.bind(this))
      .finally(() => {
        if (!freesSlot) return;
        this.inboundPhase = undefined;
        this.advanceInbound();
      });
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ClientSession.publish in src/session.ts takes the caller's Uint8Array payload and AbortSignal by identity.
  async publish(topic: string, payload: string | Uint8Array, options?: Readonly<PublishOptions>): Promise<void> {
    if (this.closing) throw closingError();
    if (this.failure) throw this.failure;
    if (!validateTopicName(topic)) throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'Invalid MQTT topic name');
    const qos: unknown = options?.qos ?? 0;
    if (qos !== 0 && qos !== 1 && qos !== 2) throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'Unsupported MQTT publish QoS');
    const signal: unknown = options?.signal;
    if (signal !== undefined && !isAbortSignal(signal))
      throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'MQTT publish signal must be an AbortSignal');
    signal?.throwIfAborted();
    if (qos > this.maximumQos) throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'Broker does not support QoS ' + String(qos));
    const publication = capturePublication(
      topic,
      payload,
      options,
      this.retainAvailable,
      this.publications.byteLimit,
      this.publications.packetLimit,
      qos,
    );
    const release = this.publications.reserve(topic, publication.payloadBytes, publication.propertyBytes, qos);
    if (qos !== 0 && this.outbound) {
      await this.outbound.enqueue(qos === 1 ? publication : { ...publication, qos }, release, signal);
      return;
    }
    if (this.resendPhase !== undefined)
      return this.afterResends(
        // oxlint-disable-next-line typescript/promise-function-async -- An async wrapper would add a promise and a microtask hop per QoS 0 publish before QosZeroWrites.run in src/qosZeroWrites.ts chains on the write.
        () => this.sendPacket(publishPacket(publication)),
        release,
      );
    await this.qosZeroWrites.run(
      // oxlint-disable-next-line typescript/promise-function-async -- Forward the native send promise directly to the write deadline owner.
      () => this.sendPacket(publishPacket(publication)),
      release,
    );
  }

  /** Write each QoS 1 or QoS 2 PUBLISH with the DUP flag `dup` and wait for its PUBACK or PUBREC. */
  private transmitter(dup: boolean) {
    return async (
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- OutgoingPublication carries the caller's Uint8Array payload, which the PUBLISH must reference without a copy (src/publication.ts).
      publication: OutgoingPublication,
      messageId: number,
      acknowledgment: Readonly<Promise<number>>,
    ): Promise<number> => {
      let sent: Promise<void> | undefined;
      try {
        return await this.run(async () => {
          sent = dup
            ? this.resend(publishPacket(publication, messageId, true))
            : this.sendIdentified(publishPacket(publication, messageId), 'MQTT publication send failed');
          const [code] = await Promise.all([acknowledgment, sent]);
          return code;
        }, 'outbound-publish');
      } finally {
        // Terminal failure can settle the caller before the native write releases its bytes.
        await sent?.catch(() => {});
      }
    };
  }

  /**
   * Write the PUBREL of an outbound QoS 2 exchange and wait for its PUBCOMP. Both reason codes of a PUBCOMP end the
   * exchange. 0x92 says the broker no longer knows the Packet Identifier, which happens when it already released the
   * message and its first PUBCOMP was lost with an earlier connection.
   */
  private async releasePublication(messageId: number, completion: Readonly<Promise<number>>, resent: boolean): Promise<number> {
    let sent: Promise<void> | undefined;
    try {
      return await this.run(async () => {
        sent = resent ? this.resend({ cmd: 'pubrel', messageId, reasonCode: 0 }) : this.answerPubrec(messageId);
        const [code] = await Promise.all([completion, sent]);
        return code;
      }, 'outbound-publish');
    } finally {
      await sent?.catch(() => {});
    }
  }

  /**
   * Write the PUBREL for a PUBREC that just arrived. A transport may deliver the PUBREC from inside its own write call,
   * and the packet input does not take bytes while it handles a packet, so the PUBREL leaves on the next microtask. The
   * PUBRELs still leave in the order the PUBRECs arrived (MQTT-4.6.0-4).
   */
  private async answerPubrec(messageId: number): Promise<void> {
    await Promise.resolve();
    // MQTT-3.14.4-1: a PUBREC that arrives once DISCONNECT is due gets no PUBREL. The exchange stays for a resume.
    if (this.writesEnded) throw this.writesEnded;
    await this.sendIdentified({ cmd: 'pubrel', messageId, reasonCode: 0 }, 'MQTT publication release failed');
  }

  /**
   * Write a resend once the write of the resend before it settled, so a transport whose write settles when its buffer
   * took the bytes meets each resend with that buffer drained. The last written resend ends the resend phase.
   */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ClientPacket in src/wireCodec.ts carries the PUBLISH payload as a mutable Uint8Array, which sendIdentified hands to the transport by identity.
  private async resend(packet: ClientPacket): Promise<void> {
    const write = async () => this.sendIdentified(packet, 'MQTT publication send failed');
    const sent =
      this.resending === undefined
        ? write()
        : this.resending.then(async () => {
            if (this.writesEnded) throw this.writesEnded;
            await write();
          });
    this.resending = sent.catch(() => {});
    await sent;
    const phase = this.resendPhase;
    if (phase !== undefined && --phase.unwritten === 0) this.endResendPhase();
  }

  /** Let the publications that waited for the resends go out. */
  private endResendPhase(): void {
    const phase = this.resendPhase;
    if (phase === undefined) return;
    this.resendPhase = undefined;
    this.resending = undefined;
    // The QoS 0 publications that waited go out first, then the queued QoS 1 publications in their call order.
    for (const { write } of phase.waiting) write();
    this.outbound?.releaseQueued();
  }

  /**
   * Write a QoS 0 publication once every resend was written. Its write deadline starts then. It keeps its admission
   * reservation while it waits, so memory stays bounded, and a session end rejects it and returns the reservation.
   */
  private async afterResends(write: () => Promise<void>, release: () => void): Promise<void> {
    const phase = this.resendPhase;
    if (phase === undefined) {
      await this.qosZeroWrites.run(write, release);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      phase.waiting.push({
        write: () => {
          this.qosZeroWrites.run(write, release).then(resolve, reject);
        },
        fail: (error) => {
          release();
          reject(error);
        },
      });
    });
  }

  /**
   * Stop every resend and waiting QoS 0 write that has not gone out, before DISCONNECT or at a session end. The stored
   * publications stay stored for a later resume.
   */
  private endWrites(error: Readonly<Error>): void {
    this.writesEnded ??= error;
    const phase = this.resendPhase;
    this.resendPhase = undefined;
    for (const { fail } of phase?.waiting ?? []) fail(error);
  }

  /** `disconnect()` dropped resends that had not started, so the phase ends once the started ones are written. */
  private dropResends(count: number): void {
    const phase = this.resendPhase;
    if (phase === undefined || count === 0) return;
    phase.unwritten -= count;
    if (phase.unwritten === 0) this.endResendPhase();
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The transport accepts the original mutable packet shape.
  private async sendIdentified(packet: ClientPacket, fallback: string): Promise<void> {
    try {
      await this.sendPacket(packet);
    } catch (reason) {
      const failure = transportFailure(reason, fallback);
      if (
        packet.cmd !== 'publish' ||
        (packet.qos !== 1 && packet.qos !== 2) ||
        takeNativeBudgetFailure(packet, reason) === undefined
      )
        void this.abort(failure).catch(() => {});
      else if (packet.dup !== true) this.session?.forget(packet.messageId);
      else {
        const conflict = new MqttError('ERR_MQTT_SESSION_CONFLICT', 'Stored MQTT publication does not fit the write budget', {
          reasonCode: 0,
          cause: failure,
        });
        void this.abort(conflict, 0).catch(() => {});
        throw conflict;
      }
      throw failure;
    }
  }

  async ping(): Promise<void> {
    if (this.closing) throw closingError();
    await (this.automaticPing ?? this.exchangePing());
  }

  private async exchangePing(background = false): Promise<void> {
    if (this.closing && (!background || !this.drainingPublications)) throw closingError();
    await this.exchange({ cmd: 'pingreq' }, (ack) => ack.cmd === 'pingresp', { background });
  }

  private startKeepAlive(intervalMs: number, lastSentAt: number): void {
    const keepAlive: KeepAlive = { intervalMs, deadline: lastSentAt + intervalMs };
    this.keepAlive = keepAlive;
    const send = this.sendPacket;
    // Only a session with a positive override observes completed writes.
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The wrapper keeps the PacketTransport['send'] signature declared in this file, whose ClientPacket carries a Uint8Array PUBLISH payload.
    this.sendPacket = async (packet) => {
      await send(packet);
      keepAlive.deadline = performance.now() + intervalMs;
    };
    this.scheduleKeepAlive();
  }

  private scheduleKeepAlive(): void {
    const keepAlive = this.keepAlive;
    if (!keepAlive || keepAlive.timer !== undefined) return;
    const remaining = () => keepAlive.deadline - performance.now();
    keepAlive.timer = setTimeout(
      () => {
        keepAlive.timer = undefined;
        if (remaining() > 0) {
          this.scheduleKeepAlive();
          return;
        }
        if (this.pendingAck) {
          void this.abort(new MqttError('ERR_MQTT_TIMEOUT', 'MQTT Keep Alive deadline expired')).catch(() => {});
          return;
        }
        // Starting the automatic PINGREQ begins the next interval.
        keepAlive.deadline = performance.now() + keepAlive.intervalMs;
        // Publish the owner before sending so a call from a diagnostic or transport callback can join it.
        this.automaticPing = Promise.resolve().then(async () => {
          try {
            await this.exchangePing(true);
          } finally {
            this.automaticPing = undefined;
          }
        });
        void this.automaticPing.catch(() => {});
        this.scheduleKeepAlive();
      },
      Math.max(0, Math.ceil(remaining())),
    );
  }

  private stopKeepAlive(): void {
    clearTimeout(this.keepAlive?.timer);
    this.keepAlive = undefined;
  }

  // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
  disconnect(options?: Readonly<DisconnectOptions>): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    let resolveClose!: () => void;
    let rejectClose!: (cause: unknown) => void;
    const closing = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.closing = closing;
    let timeout: number | undefined;
    let reasonCode: DisconnectOptions['reasonCode'];
    try {
      if (!this.failure) {
        const { drain = true, drainTimeoutMs, reasonCode: code } = options ?? {};
        const validatedTimeout = drainTimeoutMs === undefined ? this.timeoutMs : resolveTimeout(drainTimeoutMs);
        timeout = drain ? validatedTimeout : undefined;
        reasonCode = disconnectReason(code);
      }
    } catch (cause) {
      if (!this.failure) {
        this.closing = undefined;
        rejectClose(invalidOption(cause, 'Invalid MQTT disconnect options'));
        return closing;
      }
    }
    this.drainingPublications = timeout !== undefined && this.outbound?.hasActive === true;
    if (!this.drainingPublications) this.stopKeepAlive();
    this.dropResends(this.outbound?.stop(closingError()) ?? 0);
    this.nextInbound = undefined;
    void Promise.resolve()
      .then(async () => this.end(timeout, reasonCode))
      .then(resolveClose, rejectClose);
    return closing;
  }

  async abort(error: Readonly<Error>, disconnectReason?: number): Promise<void> {
    this.forcedClose ??= Promise.resolve().then(async () => {
      if (disconnectReason !== undefined) await this.reportProtocolError(disconnectReason);
      await this.transport.close(true);
    });
    try {
      this.fail(error);
    } finally {
      await this.forcedClose;
    }
  }

  private rejectProtocolInput(error: Readonly<ProtocolInputError>): void {
    if (this.failure) return;
    const notice = this.activation !== 'opening' && !this.closing ? error.reasonCode : undefined;
    void this.abort(error, notice).catch(() => {});
  }

  private async reportProtocolError(reasonCode: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.timeoutMs);
      });
      await Promise.race([deadline, this.sendPacket({ cmd: 'disconnect', reasonCode })]);
    } catch {
      // The first protocol failure remains the public cause if DISCONNECT cannot be sent.
    } finally {
      clearTimeout(timer);
    }
  }

  private async end(drainTimeoutMs: number | undefined, reasonCode: DisconnectOptions['reasonCode']): Promise<void> {
    try {
      const outbound = this.outbound;
      if (drainTimeoutMs !== undefined && outbound?.hasActive === true) await outbound.waitForActive(drainTimeoutMs);
      this.drainingPublications = false;
      this.stopKeepAlive();
      // MQTT-3.14.4-1: no packet may follow DISCONNECT.
      this.endWrites(closingError());
      await this.run(async () =>
        this.sendPacket(reasonCode === undefined ? { cmd: 'disconnect' } : { cmd: 'disconnect', reasonCode }),
      );
      if (this.failure) throw this.failure;
    } catch (error) {
      const failure = transportFailure(error, 'MQTT disconnect failed');
      await this.abort(failure).catch(() => {});
      throw failure;
    }
    this.fail(new MqttError('ERR_MQTT_CLOSING', 'Client disconnected'), 'disconnect');
    await this.transport.close();
  }

  private async exchange(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- sendPacket takes the PacketTransport['send'] ClientPacket declared in this file, whose PUBLISH payload is a Uint8Array.
    packet: ClientPacket,
    matches: (ack: Acknowledgment) => boolean,
    { onSent, background = false }: Readonly<{ onSent?: () => void; background?: boolean }> = {},
  ): Promise<Acknowledgment> {
    const failureBeforeExchange = this.failure;
    if (failureBeforeExchange) throw failureBeforeExchange;
    if (this.pendingAck) throw new MqttError('ERR_MQTT_CAPACITY', 'Another acknowledgment is pending');
    const ping = packet.cmd === 'pingreq';
    const ack = new Promise<Acknowledgment>((resolve) => {
      this.pendingAck = (reply) => {
        if (matches(reply)) resolve(reply);
      };
    });
    try {
      return await this.run(
        async () => {
          const sent = this.sendPacket(packet);
          const [received] = await Promise.all([ack, onSent ? sent.then(onSent) : sent]);
          return received;
        },
        background ? 'auto-ping' : 'operation',
      );
    } catch (error) {
      const failure = transportFailure(error, ping ? 'MQTT ping failed' : 'MQTT connect failed');
      // Retire before freeing the acknowledgment slot. PINGRESP has no request ID.
      if (ping && !this.failure && (!background || !this.closing || this.drainingPublications)) {
        await this.abort(failure).catch(() => {});
      }
      throw failure;
    } finally {
      this.pendingAck = undefined;
    }
  }

  private async run<Result>(operation: () => Promise<Result>, deadlineOwner: DeadlineOwner = 'operation'): Promise<Result> {
    if (this.failure) throw this.failure;
    let rejectOnClose!: (error: Readonly<Error>) => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      rejectOnClose = reject;
      this.pendingOperations.add(reject);
      timer = setTimeout(() => {
        if (this.failure) return;
        // The drain deadline and the DISCONNECT write own shutdown once it starts.
        if (
          this.closing &&
          (deadlineOwner === 'inbound-publish' ||
            deadlineOwner === 'outbound-publish' ||
            (deadlineOwner === 'auto-ping' && !this.drainingPublications))
        )
          return;
        void this.abort(new MqttError('ERR_MQTT_TIMEOUT', 'MQTT operation timed out')).catch(() => {});
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([interrupted, operation()]);
    } finally {
      clearTimeout(timer);
      this.pendingOperations.delete(rejectOnClose);
    }
  }

  private fail(error: Readonly<Error>, kind: 'error' | 'disconnect' = 'error'): void {
    if (this.failure) return;
    this.failure = error;
    this.releaseSession?.();
    // Held QoS 1 publications stay queued until retire rejects them.
    this.endWrites(error);
    this.drainingPublications = false;
    this.stopKeepAlive();
    this.nextInbound = undefined;
    this.subscriptions.retire(error);
    const uncertain = this.outbound?.retire(error, uncertainPublication);
    this.qosZeroWrites.retire(error);
    for (const reject of this.pendingOperations) reject(error);
    try {
      this.unlisten?.();
      this.reportConnection('retired');
    } finally {
      const observer = this.onSessionEnd;
      if (observer !== undefined) {
        queueMicrotask(() => {
          void notifyObserver(observer, kind === 'disconnect' ? { kind } : sessionError(error, uncertain));
        });
      }
    }
  }

  private reportConnection(state: 'active' | 'retired'): Error | undefined {
    if (state === 'active' && this.failure) return this.failure;
    if (this.onDiagnostic) void notifyObserver(this.onDiagnostic, { kind: 'connection', state });
    return this.failure;
  }
}

// Each PUBLISH with properties has every property key, set or undefined, so the encoder sees one object shape for them.
function publishPacket(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- OutgoingPublication carries the caller's Uint8Array payload, which the PUBLISH must reference without a copy (src/publication.ts).
  publication: OutgoingPublication,
  messageId?: number,
  dup = false,
): ClientPacket {
  const { topic, payload, retain, properties: p } = publication;
  if (messageId === undefined) {
    if (p === undefined) return { cmd: 'publish', topic, payload, retain };
    return {
      cmd: 'publish',
      topic,
      payload,
      retain,
      payloadFormatIndicator: p.payloadFormatIndicator,
      messageExpiryInterval: p.messageExpiryInterval,
      contentType: p.contentType,
      responseTopic: p.responseTopic,
      correlationData: p.correlationData,
      userProperties: p.userProperties,
    };
  }
  const qos = publication.qos ?? 1;
  if (p === undefined) return { cmd: 'publish', topic, payload, qos, messageId, dup, retain };
  return {
    cmd: 'publish',
    topic,
    payload,
    qos,
    messageId,
    dup,
    retain,
    payloadFormatIndicator: p.payloadFormatIndicator,
    messageExpiryInterval: p.messageExpiryInterval,
    contentType: p.contentType,
    responseTopic: p.responseTopic,
    correlationData: p.correlationData,
    userProperties: p.userProperties,
  };
}

function isQosTwo({ qos }: Readonly<Pick<OutgoingPublication, 'qos'>>): boolean {
  return qos === 2;
}

function uncertainPublication(
  { topic, qos }: Readonly<Pick<OutgoingPublication, 'topic' | 'qos'>>,
  messageId: number,
  acknowledged: boolean,
): UncertainPublication {
  return { topic, messageId, qos: qos ?? 1, acknowledged };
}

function sessionError(error: Readonly<Error>, uncertain: readonly UncertainPublication[] | undefined): SessionEnd {
  return uncertain === undefined || uncertain.length === 0 ? { kind: 'error', error } : { kind: 'error', error, uncertain };
}

function closingError(): MqttError {
  return new MqttError('ERR_MQTT_CLOSING', 'Client is closing');
}

export async function connectPortable<Bytes extends Uint8Array = Uint8Array>(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  transport: PacketTransport<Bytes>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  options: PortableOptions<Bytes>,
): Promise<ClientSession> {
  const client = new PortableClient(transport, options);
  let connection: ConnectionInfo;
  try {
    connection = await client.open();
  } catch (error) {
    const failure = transportFailure(error, 'MQTT connect failed');
    await client.abort(failure).catch(() => {});
    throw failure;
  }
  const session: ClientSession = {
    connection,
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    subscribe: (topic: string, options?: Readonly<SubscribeOptions>) => client.changeSubscription(topic, 'subscribe', options?.qos),
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    unsubscribe: (topic: string) => client.changeSubscription(topic, 'unsubscribe'),
    publish: client.publish.bind(client),
    ping: client.ping.bind(client),
    disconnect: client.disconnect.bind(client),
  };
  Object.defineProperty(session, 'connection', { value: connection, enumerable: true, writable: false, configurable: false });
  return session;
}
