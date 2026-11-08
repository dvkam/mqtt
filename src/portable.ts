import type { IConnectPacket, IPublishPacket, Packet } from 'mqtt-packet';
import type { ClientSession } from './session.js';
import { validateTopic } from './util/validateTopic.js';

type PublishMessage = Omit<IPublishPacket, 'payload'> & { payload: unknown };
type IncomingPacket<Message extends PublishMessage> = Exclude<Packet, IPublishPacket> | Message;

export interface PacketTransport<Message extends PublishMessage = IPublishPacket> {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  send(packet: Packet): Promise<void>;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Preserve the discriminated packet union and adapter-owned mutable payloads.
  listen(onPacket: (packet: IncomingPacket<Message>) => void, onClose: (error: Error) => void): () => void;
  /** Forced closure must promptly release pending I/O and settle. */
  close(force?: boolean): Promise<void>;
}

export interface PortableOptions<Message extends PublishMessage = IPublishPacket> {
  clientId: string;
  username?: IConnectPacket['username'];
  password?: IConnectPacket['password'];
  timeoutMs?: number;
  onMessage?: (packet: Message) => void;
}

type Acknowledgment = Extract<Packet, { cmd: 'connack' | 'suback' | 'pingresp' }>;

class PortableClient<Message extends PublishMessage> {
  private readonly transport: PacketTransport<Message>;
  private readonly options: PortableOptions<Message>;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  private pendingAck?: (packet: Acknowledgment) => void;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  private readonly pendingOperations = new Set<(error: Error) => void>();
  private failure?: Error;
  private closing?: Promise<void>;
  private readonly unlisten: (() => void) | undefined;
  private messageId = 0;
  private active = false;

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  constructor(transport: PacketTransport<Message>, options: PortableOptions<Message>) {
    this.transport = transport;
    this.options = options;
    this.unlisten = transport.listen(
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
      (packet) => {
        if (this.failure) return;
        if (packet.cmd === 'connack' || packet.cmd === 'suback' || packet.cmd === 'pingresp') this.pendingAck?.(packet);
        if (this.active && !this.closing && packet.cmd === 'publish' && packet.qos === 0) options.onMessage?.(packet);
      },
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
      (error) => {
        this.fail(error);
      },
    );
    if (this.failure) this.unlisten();
  }

  async open(): Promise<void> {
    await this.exchange(
      {
        cmd: 'connect',
        protocolVersion: 5,
        protocolId: 'MQTT',
        clean: true,
        keepalive: 0,
        clientId: this.options.clientId,
        username: this.options.username,
        password: this.options.password,
      },
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
      (ack) => ack.cmd === 'connack',
    );
    if (this.failure) throw this.failure;
    this.active = true;
  }

  async subscribe(topic: string): Promise<void> {
    if (this.closing) throw new Error('Client is closing');
    if (this.failure) throw this.failure;
    if (!validateTopic(topic)) throw new Error('Invalid MQTT topic filter');
    const messageId = this.messageId === 65_535 ? 1 : this.messageId + 1;
    this.messageId = messageId;
    await this.exchange(
      { cmd: 'subscribe', messageId, subscriptions: [{ topic, qos: 0 }] },
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
      (ack) => ack.cmd === 'suback' && ack.messageId === messageId,
    );
  }

  async publish(topic: string, payload: string): Promise<void> {
    if (this.closing) throw new Error('Client is closing');
    await this.run(async () => this.transport.send({ cmd: 'publish', topic, payload, qos: 0, dup: false, retain: false }));
  }

  async ping(): Promise<void> {
    if (this.closing) throw new Error('Client is closing');
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
    await this.exchange({ cmd: 'pingreq' }, (ack) => ack.cmd === 'pingresp');
  }

  // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
  disconnect(): Promise<void> {
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    this.closing ??= Promise.resolve().then(() => this.end());
    return this.closing;
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
  async abort(error: Error): Promise<void> {
    this.fail(error);
    await this.transport.close(true);
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
  private async exchange(packet: Packet, matches: (ack: Acknowledgment) => boolean): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.pendingAck) throw new Error('Another acknowledgment is pending');
    const ack = new Promise<Acknowledgment>((resolve) => {
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
      this.pendingAck = (reply) => {
        if (matches(reply)) resolve(reply);
      };
    });
    try {
      const reply = await this.run(async () => {
        const [received] = await Promise.all([ack, this.transport.send(packet)]);
        return received;
      });
      if (reply.cmd === 'pingresp') return;
      const code = reply.cmd === 'connack' ? reply.reasonCode : reply.granted[0];
      if (code !== 0) throw Object.assign(new Error('MQTT acknowledgment refused'), { code });
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

  private async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.failure) throw this.failure;
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Adapters retain mutable protocol packets and byte buffers shared with the session.
    let rejectOnClose!: (error: Error) => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      rejectOnClose = reject;
      this.pendingOperations.add(reject);
      timer = setTimeout(() => {
        reject(new Error('MQTT operation timed out'));
      }, this.options.timeoutMs ?? 3000);
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
    subscribe: (topic: string) => client.subscribe(topic),
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    publish: (topic: string, payload: string) => client.publish(topic, payload),
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    ping: () => client.ping(),
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    disconnect: () => client.disconnect(),
  };
}
