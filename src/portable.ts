import { notifyObserver, packetReceiver, packetSender, type DiagnosticObserver } from './diagnostics.js';
import { MqttError } from './mqttError.js';
import { ProtocolInputError } from './protocolInputError.js';
import type { PublishMessage } from './messageProperties.js';
import type { BrokerPacket, ClientPacket } from './wireCodec.js';
import type { ClientSession, QosOneMessage, SessionEndObserver, SubscribeOptions } from './session.js';
import { validateTopic } from './util/validateTopic.js';
import { resolveTimeout } from './timeout.js';
import { PublicationAdmission, type PublicationLimits } from './publicationAdmission.js';
import { SubscriptionExchanges, type SubscriptionLimits } from './subscriptionExchanges.js';
import { PacketIdentifiers } from './packetIdentifiers.js';
import { OutboundQosOne } from './outboundQosOne.js';
import { isPubackReason } from './pubackReason.js';
import { takeNativeBudgetFailure } from './nativeWriteBudget.js';

export type { ClientDiagnostic, DiagnosticObserver } from './diagnostics.js';
export type { SessionEnd, SessionEndObserver } from './session.js';
export { ProtocolInputError } from './protocolInputError.js';
export type { ProtocolInputCode } from './protocolInputError.js';
export type { BrokerPacket, ClientPacket } from './wireCodec.js';
export type { MessageProperties, PublishMessage } from './messageProperties.js';
export type { QosOneMessage } from './session.js';

const payloadEncoder = new TextEncoder();

/** What a transport delivers: the codec's broker packets and received messages with `Bytes` payloads. */
export type ReceivedPacket<Bytes extends Uint8Array = Uint8Array> =
  | Exclude<BrokerPacket, { cmd: 'publish' }>
  | PublishMessage<Bytes>
  | QosOneMessage<PublishMessage<Bytes>>;

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
  timeoutMs?: number;
  onDiagnostic?: DiagnosticObserver;
  onSessionEnd?: SessionEndObserver;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Delivery preserves the adapter's mutable byte buffer type.
  onMessage?: (packet: PublishMessage<Bytes>) => void;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Delivery preserves the adapter's mutable byte buffer type.
  onQosOneMessage?: (packet: QosOneMessage<PublishMessage<Bytes>>) => void | Promise<void>;
}

type InboundPhase = 'handling' | 'acknowledging';
type Connack = Extract<BrokerPacket, { cmd: 'connack' }>;
type Acknowledgment =
  | Readonly<Pick<Connack, 'cmd' | 'reasonCode' | 'sessionPresent' | 'receiveMaximum' | 'maximumQoS' | 'serverKeepAlive'>>
  | Readonly<{ cmd: 'pingresp' }>;

interface KeepAlive {
  readonly intervalMs: number;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
}

class PortableClient<Bytes extends Uint8Array> {
  private readonly transport: PacketTransport<Bytes>;
  private sendPacket: PacketTransport<Bytes>['send'];
  private readonly onDiagnostic: DiagnosticObserver | undefined;
  private readonly onSessionEnd: SessionEndObserver | undefined;
  private readonly options: PortableOptions<Bytes>;
  private readonly clientId: string;
  private pendingAck?: (packet: Acknowledgment) => void;
  private keepAlive?: KeepAlive;
  private automaticPing?: Promise<void>;
  private readonly pendingOperations = new Set<(error: Readonly<Error>) => void>();
  private failure?: Error;
  private closing?: Promise<void>;
  private forcedClose?: Promise<void>;
  private readonly unlisten: (() => void) | undefined;
  private readonly subscriptions: SubscriptionExchanges;
  private readonly identifiers = new PacketIdentifiers();
  private outbound?: OutboundQosOne;
  private activation: 'opening' | 'accepted' | 'active' = 'opening';
  private connackReceived = false;
  private inboundPhase?: InboundPhase;
  private nextInbound?: QosOneMessage<PublishMessage<Bytes>>;
  private readonly onQosOneMessage: PortableOptions<Bytes>['onQosOneMessage'];
  private readonly timeoutMs: number;
  private readonly publications: PublicationAdmission;

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  constructor(transport: PacketTransport<Bytes>, options: PortableOptions<Bytes>) {
    this.timeoutMs = resolveTimeout(options.timeoutMs);
    this.publications = new PublicationAdmission(options);
    this.subscriptions = new SubscriptionExchanges(options, this.identifiers);
    this.transport = transport;
    this.onDiagnostic = options.onDiagnostic;
    this.onSessionEnd = options.onSessionEnd;
    this.sendPacket = packetSender(transport, this.onDiagnostic);
    this.options = options;
    this.clientId = options.clientId;
    this.onQosOneMessage = options.onQosOneMessage;
    this.unlisten = transport.listen(
      packetReceiver(
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
        (packet: ReceivedPacket<Bytes>) => {
          if (this.failure) return;
          if (packet.cmd === 'connack') {
            if (this.connackReceived) {
              this.rejectProtocolInput(new ProtocolInputError('Duplicate MQTT CONNACK', 0x82));
              return;
            }
            this.connackReceived = true;
            if (packet.sessionPresent) {
              this.rejectProtocolInput(new ProtocolInputError('Unexpected MQTT Session Present', 0x82));
              return;
            }
            const { authenticationMethod, authenticationData, assignedClientIdentifier } = packet;
            if (authenticationMethod !== undefined || authenticationData !== undefined) {
              this.rejectProtocolInput(new ProtocolInputError('Unexpected MQTT authentication properties', 0x82));
              return;
            }
            if (
              packet.reasonCode === 0 &&
              ((this.clientId === '' && assignedClientIdentifier === undefined) ||
                (assignedClientIdentifier !== undefined &&
                  (typeof assignedClientIdentifier !== 'string' ||
                    assignedClientIdentifier.length === 0 ||
                    assignedClientIdentifier.length > 65_535 ||
                    /[\uD800-\uDFFF]/u.test(assignedClientIdentifier) ||
                    assignedClientIdentifier.includes('\u0000') ||
                    new TextEncoder().encode(assignedClientIdentifier).byteLength > 65_535 ||
                    (this.clientId !== '' && assignedClientIdentifier !== this.clientId))))
            ) {
              this.rejectProtocolInput(new ProtocolInputError('Invalid MQTT Assigned Client Identifier', 0x82));
              return;
            }
          }
          if (packet.cmd === 'disconnect') {
            void this.abort(
              new MqttError('ERR_MQTT_BROKER_DISCONNECT', 'MQTT broker disconnected', {
                fatal: true,
                reasonCode: packet.reasonCode ?? 0,
                reasonString: packet.reasonString,
                userProperties: packet.userProperties,
              }),
            ).catch(() => {});
            return;
          }
          if (packet.cmd === 'suback' || packet.cmd === 'unsuback') {
            const code = this.subscriptions.accept(packet.messageId, packet.granted, packet.cmd);
            if (code !== undefined) {
              this.rejectProtocolInput(new ProtocolInputError('Invalid MQTT subscription acknowledgment', code));
              return;
            }
          }
          if (packet.cmd === 'puback') {
            const { messageId, reasonCode: code } = packet;
            if (!Number.isInteger(messageId) || messageId < 1 || messageId > 65_535) {
              void this.abort(protocolError('Invalid PUBACK packet identifier')).catch(() => {});
              return;
            }
            if (!isPubackReason(code)) {
              void this.abort(protocolError('Invalid PUBACK reason code')).catch(() => {});
              return;
            }
            this.outbound?.accept(messageId, code);
          }
          if (packet.cmd === 'connack' || packet.cmd === 'pingresp') this.pendingAck?.(packet);
          if (this.closing || packet.cmd !== 'publish') return;
          if (this.activation === 'active' && packet.qos === 0) options.onMessage?.(packet);
          if (packet.qos === 1 && this.onQosOneMessage) {
            const { messageId, dup } = packet;
            if (!Number.isInteger(messageId) || messageId < 1 || messageId > 65_535 || typeof dup !== 'boolean') {
              void this.abort(protocolError('Invalid inbound QoS 1 PUBLISH')).catch(() => {});
              return;
            }
            this.receiveQosOne({ ...packet, qos: 1, messageId, dup });
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

  async open(): Promise<void> {
    let connectSentAt = 0;
    const reply = await this.exchange(
      {
        cmd: 'connect',
        clientId: this.clientId,
        cleanStart: true,
        keepAlive: 0,
        username: this.options.username,
        password: this.options.password,
        ...(this.onQosOneMessage ? { receiveMaximum: 1 } : {}),
      },
      (ack) => ack.cmd === 'connack',
      {
        onSent: () => {
          connectSentAt = performance.now();
        },
      },
    );
    if (this.failure) throw this.failure;
    if (reply.cmd !== 'connack') throw protocolError('Expected CONNACK');
    const { receiveMaximum = 65_535, maximumQoS, serverKeepAlive = 0 } = reply;
    if (!Number.isInteger(receiveMaximum) || receiveMaximum < 1 || receiveMaximum > 65_535)
      throw protocolError('Invalid broker Receive Maximum');
    if (maximumQoS !== undefined && maximumQoS !== 0 && maximumQoS !== 1) throw protocolError('Invalid broker Maximum QoS');
    if (maximumQoS !== 0) {
      this.outbound = new OutboundQosOne(receiveMaximum, this.identifiers, this.transmitQosOne.bind(this));
    }
    this.activation = 'active';
    if (serverKeepAlive > 0) this.startKeepAlive(serverKeepAlive * 1000, connectSentAt);
    this.advanceInbound();
    const interrupted = this.reportConnection('active');
    if (interrupted) throw interrupted;
  }

  async changeSubscription(topic: string, command: 'subscribe' | 'unsubscribe', qos = 0): Promise<void> {
    if (this.closing) throw closingError();
    if (this.failure) throw this.failure;
    if (!validateTopic(topic)) throw invalidArgument('Invalid MQTT topic filter');
    if (this.transport.supportsSharedSubscriptions === false && topic.startsWith('$share/'))
      throw invalidArgument('Unsupported shared subscription');
    if (qos !== 0 && qos !== 1) throw invalidArgument('Unsupported MQTT subscription QoS');
    if (qos === 1 && !this.onQosOneMessage) throw invalidArgument('QoS 1 subscription requires onQosOneMessage');
    const subscribing = command === 'subscribe';
    const reservation = this.subscriptions.reserve(topic, subscribing ? 'suback' : 'unsuback', qos);
    const { messageId } = reservation;
    const packet: ClientPacket = subscribing
      ? { cmd: 'subscribe', messageId, topics: [topic], qos }
      : { cmd: 'unsubscribe', messageId, topics: [topic] };
    await this.run(async () => {
      try {
        const sent = this.sendIdentified(packet, subscribing ? 'MQTT subscription send failed' : 'MQTT unsubscribe send failed');
        const [code] = await Promise.all([reservation.acknowledged, sent]);
        if (code !== 0 && code !== (subscribing ? qos : 17)) throw refusedError(code, false);
      } finally {
        reservation.release();
      }
    });
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The handler receives the adapter's mutable packet payload.
  private receiveQosOne(packet: QosOneMessage<PublishMessage<Bytes>>): void {
    if (this.activation === 'opening') {
      void this.abort(protocolError('Inbound QoS 1 PUBLISH arrived before CONNACK')).catch(() => {});
      return;
    }
    const canWait = this.activation === 'accepted' || this.inboundPhase === 'acknowledging';
    if (canWait && !this.nextInbound) {
      this.nextInbound = packet;
      return;
    }
    if (canWait || this.inboundPhase) {
      void this.abort(protocolError('MQTT Receive Maximum exceeded', 0x93), 0x93).catch(() => {});
      return;
    }
    this.inboundPhase = 'handling';
    void this.deliverQosOne(packet);
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
      }, false);
    } catch (reason) {
      if (!this.failure && !this.closing)
        void this.abort(reason instanceof Error ? reason : new Error('MQTT inbound delivery failed')).catch(() => {});
    } finally {
      this.inboundPhase = undefined;
      this.advanceInbound();
    }
  }

  private advanceInbound(): void {
    const next = this.nextInbound;
    this.nextInbound = undefined;
    if (next && !this.failure && !this.closing) this.receiveQosOne(next);
  }

  async publish(
    topic: string,
    payload: string,
    options?: Readonly<{ qos?: 0 | 1; signal?: Readonly<AbortSignal> }>,
  ): Promise<void> {
    if (this.closing) throw closingError();
    if (this.failure) throw this.failure;
    if (topic.includes('+') || topic.includes('#') || !validateTopic(topic)) throw invalidArgument('Invalid MQTT topic name');
    const { qos = 0, signal } = options ?? {};
    if (![0, 1].includes(qos)) throw invalidArgument('Unsupported MQTT publish QoS');
    if (qos === 1) {
      signal?.throwIfAborted();
      if (!this.outbound) throw invalidArgument('Broker does not support QoS 1');
      await this.outbound.enqueue(topic, payload, this.publications.reserve(topic, payload, qos), signal);
      return;
    }
    if (signal !== undefined) throw invalidArgument('Publish cancellation requires QoS 1');
    const release = this.publications.reserve(topic, payload);
    await this.run(async () => {
      try {
        await this.sendPacket({ cmd: 'publish', topic, payload: payloadEncoder.encode(payload), retain: false });
      } finally {
        release();
      }
    });
  }

  private async transmitQosOne(
    topic: string,
    payload: string,
    messageId: number,
    acknowledgment: Readonly<Promise<number>>,
  ): Promise<number> {
    let sent: Promise<void> | undefined;
    try {
      return await this.run(async () => {
        sent = this.sendIdentified(
          { cmd: 'publish', topic, payload: payloadEncoder.encode(payload), qos: 1, messageId, dup: false, retain: false },
          'MQTT publication send failed',
        );
        const [code] = await Promise.all([acknowledgment, sent]);
        return code;
      });
    } finally {
      // Terminal failure can settle the caller before the native write releases its bytes.
      await sent?.catch(() => {});
    }
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The transport accepts the original mutable packet shape.
  private async sendIdentified(packet: ClientPacket, fallback: string): Promise<void> {
    try {
      await this.sendPacket(packet);
    } catch (reason) {
      const refusedBeforeWrite =
        packet.cmd === 'publish' && packet.qos === 1 && takeNativeBudgetFailure(packet, reason) !== undefined;
      if (!refusedBeforeWrite) void this.abort(reason instanceof Error ? reason : new Error(fallback)).catch(() => {});
      throw reason;
    }
  }

  async ping(): Promise<void> {
    if (this.closing) throw closingError();
    await (this.automaticPing ?? this.exchangePing());
  }

  private async exchangePing(background = false): Promise<void> {
    if (this.closing) throw closingError();
    await this.exchange({ cmd: 'pingreq' }, (ack) => ack.cmd === 'pingresp', { background });
  }

  private startKeepAlive(intervalMs: number, lastSentAt: number): void {
    const keepAlive: KeepAlive = { intervalMs, deadline: lastSentAt + intervalMs };
    this.keepAlive = keepAlive;
    const send = this.sendPacket;
    // Only a session with a positive override observes completed writes.
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Forward the same mutable packet to the writer.
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
          void this.abort(new MqttError('ERR_MQTT_TIMEOUT', 'MQTT Keep Alive deadline expired', { fatal: true })).catch(() => {});
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
  disconnect(): Promise<void> {
    if (this.closing === undefined) {
      this.closing = Promise.resolve().then(this.end.bind(this));
      this.stopKeepAlive();
      this.outbound?.stop(closingError());
      this.nextInbound = undefined;
    }
    return this.closing;
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
    const notice = this.activation !== 'opening' && !this.closing ? error.code : undefined;
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

  private async end(): Promise<void> {
    try {
      await this.run(async () => this.sendPacket({ cmd: 'disconnect' }));
    } catch (error) {
      await this.abort(error instanceof Error ? error : new Error('MQTT disconnect failed')).catch(() => {});
      throw error;
    }
    this.fail(new MqttError('ERR_MQTT_CLOSING', 'Client disconnected', { fatal: true }), 'disconnect');
    await this.transport.close();
  }

  private async exchange(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
    packet: ClientPacket,
    matches: (ack: Acknowledgment) => boolean,
    { onSent, background = false }: Readonly<{ onSent?: () => void; background?: boolean }> = {},
  ): Promise<Acknowledgment> {
    const failureBeforeExchange = this.failure;
    if (failureBeforeExchange) throw failureBeforeExchange;
    if (this.pendingAck) throw new MqttError('ERR_MQTT_CAPACITY', 'Another acknowledgment is pending', { fatal: false });
    const ping = packet.cmd === 'pingreq';
    const ack = new Promise<Acknowledgment>((resolve) => {
      this.pendingAck = (reply) => {
        if (matches(reply)) {
          if (reply.cmd === 'connack' && reply.reasonCode !== 0) {
            this.fail(refusedError(reply.reasonCode, true));
          }
          if (reply.cmd === 'connack') {
            if (reply.reasonCode === 0) this.activation = 'accepted';
            resolve({
              cmd: 'connack',
              reasonCode: reply.reasonCode,
              sessionPresent: reply.sessionPresent,
              receiveMaximum: reply.receiveMaximum,
              maximumQoS: reply.maximumQoS,
              serverKeepAlive: reply.serverKeepAlive,
            });
          } else resolve(reply);
        }
      };
    });
    try {
      const reply = await this.run(async () => {
        const sent = this.sendPacket(packet);
        const [received] = await Promise.all([ack, onSent ? sent.then(onSent) : sent]);
        return received;
      }, !background);
      if (reply.cmd === 'connack' && reply.reasonCode !== 0) throw refusedError(reply.reasonCode, true);
      return reply;
    } catch (error) {
      // Retire before freeing the acknowledgment slot. PINGRESP has no request ID.
      if (ping && !this.failure && (!background || !this.closing)) {
        await this.abort(error instanceof Error ? error : new Error('MQTT ping failed')).catch(() => {});
      }
      throw error;
    } finally {
      this.pendingAck = undefined;
    }
  }

  private async run<Result>(operation: () => Promise<Result>, timeoutWhileClosing = true): Promise<Result> {
    if (this.failure) throw this.failure;
    let rejectOnClose!: (error: Readonly<Error>) => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      rejectOnClose = reject;
      this.pendingOperations.add(reject);
      timer = setTimeout(() => {
        if (this.failure || (!timeoutWhileClosing && this.closing)) return;
        void this.abort(new MqttError('ERR_MQTT_TIMEOUT', 'MQTT operation timed out', { fatal: true })).catch(() => {});
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
    this.stopKeepAlive();
    this.nextInbound = undefined;
    this.subscriptions.retire(error);
    this.outbound?.retire(error);
    for (const reject of this.pendingOperations) reject(error);
    try {
      this.unlisten?.();
      this.reportConnection('retired');
    } finally {
      const observer = this.onSessionEnd;
      if (observer !== undefined) {
        queueMicrotask(() => {
          void notifyObserver(observer, kind === 'disconnect' ? { kind } : { kind, error });
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

function protocolError(message: string, reasonCode?: number): MqttError {
  return new MqttError('ERR_MQTT_PROTOCOL', message, reasonCode === undefined ? { fatal: true } : { fatal: true, reasonCode });
}

function invalidArgument(message: string): MqttError {
  return new MqttError('ERR_MQTT_INVALID_ARGUMENT', message, { fatal: false });
}

function closingError(): MqttError {
  return new MqttError('ERR_MQTT_CLOSING', 'Client is closing', { fatal: true });
}

// A refused CONNACK ends the session. A refused SUBACK or UNSUBACK leaves it usable.
function refusedError(reasonCode: number, fatal: boolean): MqttError {
  return new MqttError('ERR_MQTT_REFUSED', 'MQTT acknowledgment refused', { fatal, reasonCode });
}

export async function connectPortable<Bytes extends Uint8Array = Uint8Array>(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  transport: PacketTransport<Bytes>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  options: PortableOptions<Bytes>,
): Promise<ClientSession> {
  const client = new PortableClient(transport, options);
  try {
    await client.open();
  } catch (error) {
    await client.abort(error instanceof Error ? error : new Error('MQTT connect failed')).catch(() => {});
    throw error;
  }
  return {
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    subscribe: (topic: string, options?: Readonly<SubscribeOptions>) => client.changeSubscription(topic, 'subscribe', options?.qos),
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    unsubscribe: (topic: string) => client.changeSubscription(topic, 'unsubscribe'),
    publish: client.publish.bind(client),
    ping: client.ping.bind(client),
    disconnect: client.disconnect.bind(client),
  };
}
