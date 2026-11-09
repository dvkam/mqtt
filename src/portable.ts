import type { IConnectPacket, IPublishPacket, Packet } from 'mqtt-packet';
import type { ClientSession, PublishOptions, QosOneMessage, SubscribeOptions } from './session.js';
import { validateTopic } from './util/validateTopic.js';
import { resolveTimeout } from './timeout.js';
import { PublicationAdmission, type PublicationLimits } from './publicationAdmission.js';
import { SubscriptionExchanges, type SubscriptionLimits } from './subscriptionExchanges.js';
import { PacketIdentifiers } from './packetIdentifiers.js';
import { OutboundQosOne } from './outboundQosOne.js';
import { isPubackReason } from './pubackReason.js';

type PublishMessage = Omit<IPublishPacket, 'payload'> & { payload: unknown };
type IncomingPacket<Message extends PublishMessage> = Exclude<Packet, IPublishPacket> | Message | QosOneMessage<Message>;

export interface PacketTransport<Message extends PublishMessage = IPublishPacket> {
  /** Whether this adapter can encode shared filters. Broker capabilities are separate. */
  readonly supportsSharedSubscriptions?: boolean;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  send(packet: Packet): Promise<void>;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Preserve the discriminated packet union and adapter-owned mutable payloads.
  listen(onPacket: (packet: IncomingPacket<Message>) => void, onClose: (error: Error) => void): () => void;
  /** Forced closure must promptly release pending I/O and settle. */
  close(force?: boolean): Promise<void>;
}

export interface PortableOptions<Message extends PublishMessage = IPublishPacket> extends PublicationLimits, SubscriptionLimits {
  clientId: string;
  username?: IConnectPacket['username'];
  password?: IConnectPacket['password'];
  timeoutMs?: number;
  onMessage?: (packet: Message) => void;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Delivery preserves the adapter's mutable byte buffer type.
  onQosOneMessage?: (packet: QosOneMessage<Message>) => void | Promise<void>;
}

type InboundPhase = 'handling' | 'acknowledging';
type Acknowledgment = Extract<Packet, { cmd: 'connack' | 'pingresp' }>;

class PortableClient<Message extends PublishMessage> {
  private readonly transport: PacketTransport<Message>;
  private readonly options: PortableOptions<Message>;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  private pendingAck?: (packet: Acknowledgment) => void;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  private readonly pendingOperations = new Set<(error: Error) => void>();
  private failure?: Error;
  private closing?: Promise<void>;
  private forcedClose?: Promise<void>;
  private readonly unlisten: (() => void) | undefined;
  private readonly subscriptions: SubscriptionExchanges;
  private readonly identifiers = new PacketIdentifiers();
  private outbound?: OutboundQosOne;
  private activation: 'opening' | 'accepted' | 'active' = 'opening';
  private inboundPhase?: InboundPhase;
  private nextInbound?: QosOneMessage<Message>;
  private readonly onQosOneMessage: PortableOptions<Message>['onQosOneMessage'];
  private readonly timeoutMs: number;
  private readonly publications: PublicationAdmission;

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  constructor(transport: PacketTransport<Message>, options: PortableOptions<Message>) {
    this.timeoutMs = resolveTimeout(options.timeoutMs);
    this.publications = new PublicationAdmission(options);
    this.subscriptions = new SubscriptionExchanges(options, this.identifiers);
    this.transport = transport;
    this.options = options;
    this.onQosOneMessage = options.onQosOneMessage;
    this.unlisten = transport.listen(
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
      (packet) => {
        if (this.failure) return;
        if (packet.cmd === 'disconnect') {
          void this.abort(Object.assign(new Error('MQTT broker disconnected'), { code: packet.reasonCode ?? 0 })).catch(() => {});
          return;
        }
        if (packet.cmd === 'suback' || packet.cmd === 'unsuback')
          this.subscriptions.accept(packet.messageId, packet.granted, packet.cmd);
        if (packet.cmd === 'puback') {
          const { messageId, reasonCode: code = 0 } = packet;
          if (messageId === undefined || !Number.isInteger(messageId) || messageId < 1 || messageId > 65_535) {
            void this.abort(new Error('Invalid PUBACK packet identifier')).catch(() => {});
            return;
          }
          if (!isPubackReason(code)) {
            void this.abort(new Error('Invalid PUBACK reason code')).catch(() => {});
            return;
          }
          this.outbound?.accept(messageId, code);
        }
        if (packet.cmd === 'connack' || packet.cmd === 'pingresp') this.pendingAck?.(packet);
        if (this.closing || packet.cmd !== 'publish') return;
        if (this.activation === 'active' && packet.qos === 0) options.onMessage?.(packet);
        if (packet.qos === 1 && this.onQosOneMessage) {
          const { messageId, dup } = packet;
          if (
            messageId === undefined ||
            !Number.isInteger(messageId) ||
            messageId < 1 ||
            messageId > 65_535 ||
            typeof dup !== 'boolean'
          ) {
            void this.abort(new Error('Invalid inbound QoS 1 PUBLISH')).catch(() => {});
            return;
          }
          this.receiveQosOne({ ...packet, qos: 1, messageId, dup });
        }
      },
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
      (error) => {
        this.fail(error);
      },
    );
    if (this.failure) this.unlisten();
  }

  async open(): Promise<void> {
    const reply = await this.exchange(
      {
        cmd: 'connect',
        protocolVersion: 5,
        protocolId: 'MQTT',
        clean: true,
        keepalive: 0,
        clientId: this.options.clientId,
        username: this.options.username,
        password: this.options.password,
        ...(this.onQosOneMessage ? { properties: { receiveMaximum: 1 } } : {}),
      },
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
      (ack) => ack.cmd === 'connack',
    );
    if (this.failure) throw this.failure;
    if (reply.cmd !== 'connack') throw new Error('Expected CONNACK');
    const { receiveMaximum = 65_535, maximumQoS } = reply.properties ?? {};
    if (!Number.isInteger(receiveMaximum) || receiveMaximum < 1 || receiveMaximum > 65_535)
      throw new Error('Invalid broker Receive Maximum');
    if (maximumQoS !== undefined && maximumQoS !== 0 && maximumQoS !== 1) throw new Error('Invalid broker Maximum QoS');
    if (maximumQoS !== 0) {
      this.outbound = new OutboundQosOne(receiveMaximum, this.identifiers, this.transmitQosOne.bind(this));
    }
    this.activation = 'active';
    this.advanceInbound();
  }

  async changeSubscription(topic: string, command: 'subscribe' | 'unsubscribe', qos = 0): Promise<void> {
    if (this.closing) throw new Error('Client is closing');
    if (this.failure) throw this.failure;
    if (!validateTopic(topic)) throw new Error('Invalid MQTT topic filter');
    if (this.transport.supportsSharedSubscriptions === false && topic.startsWith('$share/'))
      throw new Error('Unsupported shared subscription');
    if (qos !== 0 && qos !== 1) throw new RangeError('Unsupported MQTT subscription QoS');
    if (qos === 1 && !this.onQosOneMessage) throw new Error('QoS 1 subscription requires onQosOneMessage');
    const subscribing = command === 'subscribe';
    const reservation = this.subscriptions.reserve(topic, subscribing ? 'suback' : 'unsuback');
    const { messageId } = reservation;
    const packet: Packet = subscribing
      ? { cmd: 'subscribe', messageId, subscriptions: [{ topic, qos }] }
      : { cmd: 'unsubscribe', messageId, unsubscriptions: [topic] };
    await this.run(async () => {
      try {
        const sent = this.sendIdentified(packet, subscribing ? 'MQTT subscription send failed' : 'MQTT unsubscribe send failed');
        const [code] = await Promise.all([reservation.acknowledged, sent]);
        if (code !== 0 && code !== (subscribing ? qos : 17))
          throw Object.assign(new Error('MQTT acknowledgment refused'), { code });
      } finally {
        reservation.release();
      }
    });
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The handler receives the adapter's mutable packet payload.
  private receiveQosOne(packet: QosOneMessage<Message>): void {
    if (this.activation === 'opening') {
      void this.abort(new Error('Inbound QoS 1 PUBLISH arrived before CONNACK')).catch(() => {});
      return;
    }
    const canWait = this.activation === 'accepted' || this.inboundPhase === 'acknowledging';
    if (canWait && !this.nextInbound) {
      this.nextInbound = packet;
      return;
    }
    if (canWait || this.inboundPhase) {
      void this.abort(Object.assign(new Error('MQTT Receive Maximum exceeded'), { code: 0x93 }), 0x93).catch(() => {});
      return;
    }
    this.inboundPhase = 'handling';
    void this.deliverQosOne(packet);
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Preserve the mutable application payload while keeping the ACK identifier private.
  private async deliverQosOne(packet: QosOneMessage<Message>): Promise<void> {
    const { messageId } = packet;
    try {
      await this.run(async () => {
        await this.onQosOneMessage?.(packet);
        if (this.failure || this.closing) return;
        this.inboundPhase = 'acknowledging';
        await this.transport.send({ cmd: 'puback', messageId, reasonCode: 0 });
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

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Preserve the caller's native AbortSignal identity and listener contract.
  async publish(topic: string, payload: string, options?: Readonly<PublishOptions>): Promise<void> {
    if (this.closing) throw new Error('Client is closing');
    if (this.failure) throw this.failure;
    if (topic.includes('+') || topic.includes('#') || !validateTopic(topic)) throw new Error('Invalid MQTT topic name');
    const { qos = 0, signal } = options ?? {};
    if (![0, 1].includes(qos)) throw new RangeError('Unsupported MQTT publish QoS');
    if (qos === 1) {
      signal?.throwIfAborted();
      if (!this.outbound) throw new Error('Broker does not support QoS 1');
      await this.outbound.enqueue(topic, payload, this.publications.reserve(topic, payload, qos), signal);
      return;
    }
    if (signal !== undefined) throw new Error('Publish cancellation requires QoS 1');
    const release = this.publications.reserve(topic, payload);
    await this.run(async () => {
      try {
        await this.transport.send({
          cmd: 'publish',
          topic,
          payload,
          qos: 0,
          dup: false,
          retain: false,
        });
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
          { cmd: 'publish', topic, payload, qos: 1, messageId, dup: false, retain: false },
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
  private async sendIdentified(packet: Packet, fallback: string): Promise<void> {
    try {
      await this.transport.send(packet);
    } catch (reason) {
      void this.abort(reason instanceof Error ? reason : new Error(fallback)).catch(() => {});
      throw reason;
    }
  }

  async ping(): Promise<void> {
    if (this.closing) throw new Error('Client is closing');
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
    await this.exchange({ cmd: 'pingreq' }, (ack) => ack.cmd === 'pingresp');
  }

  // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
  disconnect(): Promise<void> {
    if (this.closing === undefined) {
      // oxlint-disable-next-line typescript/promise-function-async -- Cache the promise before stopping queued work.
      this.closing = Promise.resolve().then(() => this.end());
      this.outbound?.stop(new Error('Client is closing'));
      this.nextInbound = undefined;
    }
    return this.closing;
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  async abort(error: Error, disconnectReason?: number): Promise<void> {
    try {
      this.fail(error);
    } finally {
      this.forcedClose ??= Promise.resolve().then(async () => {
        if (disconnectReason !== undefined) await this.reportProtocolError(disconnectReason);
        await this.transport.close(true);
      });
      await this.forcedClose;
    }
  }

  private async reportProtocolError(reasonCode: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.timeoutMs);
      });
      await Promise.race([deadline, this.transport.send({ cmd: 'disconnect', reasonCode })]);
    } catch {
      // The first protocol failure remains the public cause if DISCONNECT cannot be sent.
    } finally {
      clearTimeout(timer);
    }
  }

  private async end(): Promise<void> {
    try {
      await this.run(async () => this.transport.send({ cmd: 'disconnect' }));
    } catch (error) {
      await this.abort(error instanceof Error ? error : new Error('MQTT disconnect failed')).catch(() => {});
      throw error;
    }
    this.fail(new Error('Client disconnected'));
    await this.transport.close();
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  private async exchange(packet: Packet, matches: (ack: Acknowledgment) => boolean): Promise<Acknowledgment> {
    if (this.failure) throw this.failure;
    if (this.pendingAck) throw new Error('Another acknowledgment is pending');
    const ack = new Promise<Acknowledgment>((resolve) => {
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
      this.pendingAck = (reply) => {
        if (matches(reply)) {
          if (reply.cmd === 'connack' && reply.reasonCode !== 0) {
            this.fail(Object.assign(new Error('MQTT acknowledgment refused'), { code: reply.reasonCode }));
          }
          if (reply.cmd === 'connack') {
            if (reply.reasonCode === 0) this.activation = 'accepted';
            const { receiveMaximum, maximumQoS } = reply.properties ?? {};
            resolve({
              cmd: 'connack',
              reasonCode: reply.reasonCode,
              sessionPresent: reply.sessionPresent,
              properties: { receiveMaximum, maximumQoS },
            });
          } else resolve(reply);
        }
      };
    });
    try {
      const reply = await this.run(async () => {
        const [received] = await Promise.all([ack, this.transport.send(packet)]);
        return received;
      });
      if (reply.cmd === 'connack' && reply.reasonCode !== 0)
        throw Object.assign(new Error('MQTT acknowledgment refused'), { code: reply.reasonCode });
      return reply;
    } catch (error) {
      // Retire before freeing the acknowledgment slot. PINGRESP has no request ID.
      // oxlint-disable-next-line typescript/no-unnecessary-condition, typescript/strict-boolean-expressions -- Transport callbacks can record failure while this exchange awaits I/O.
      if (packet.cmd === 'pingreq' && !this.failure) {
        await this.abort(error instanceof Error ? error : new Error('MQTT ping failed')).catch(() => {});
      }
      throw error;
    } finally {
      this.pendingAck = undefined;
    }
  }

  private async run<Result>(operation: () => Promise<Result>, timeoutWhileClosing = true): Promise<Result> {
    if (this.failure) throw this.failure;
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
    let rejectOnClose!: (error: Error) => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      rejectOnClose = reject;
      this.pendingOperations.add(reject);
      timer = setTimeout(() => {
        if (this.failure || (!timeoutWhileClosing && this.closing)) return;
        void this.abort(new Error('MQTT operation timed out')).catch(() => {});
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([interrupted, operation()]);
    } finally {
      clearTimeout(timer);
      this.pendingOperations.delete(rejectOnClose);
    }
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.nextInbound = undefined;
    this.subscriptions.retire(error);
    this.outbound?.retire(error);
    for (const reject of this.pendingOperations) reject(error);
    this.unlisten?.();
  }
}

export async function connectPortable<Message extends PublishMessage = IPublishPacket>(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  transport: PacketTransport<Message>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  options: PortableOptions<Message>,
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
    // oxlint-disable-next-line typescript/promise-function-async, typescript/prefer-readonly-parameter-types -- Forward the existing promise and native cancellation signal.
    publish: (topic: string, payload: string, publishOptions?: Readonly<PublishOptions>) =>
      client.publish(topic, payload, publishOptions),
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    ping: () => client.ping(),
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    disconnect: () => client.disconnect(),
  };
}
