import type { IConnectPacket, IPublishPacket, Packet } from 'mqtt-packet';

export interface PacketTransport {
  send(packet: Packet): Promise<void>;
  listen(onPacket: (packet: Packet) => void, onClose: (error: Error) => void): () => void;
  /** Forced closure must promptly release pending I/O and settle. */
  close(force?: boolean): Promise<void>;
}

interface PortableOptions {
  clientId: string;
  username?: IConnectPacket['username'];
  password?: IConnectPacket['password'];
  timeoutMs?: number;
  onMessage?: (packet: IPublishPacket) => void;
}

type Acknowledgment = Extract<Packet, { cmd: 'connack' | 'suback' | 'pingresp' }>;

class PortableClient {
  private pendingAck?: (packet: Acknowledgment) => void;
  private readonly pendingOperations = new Set<(error: Error) => void>();
  private failure?: Error;
  private closing?: Promise<void>;
  private readonly unlisten: () => void;
  private messageId = 0;

  constructor(
    private readonly transport: PacketTransport,
    private readonly options: PortableOptions,
  ) {
    this.unlisten = transport.listen(
      (packet) => {
        if (packet.cmd === 'connack' || packet.cmd === 'suback' || packet.cmd === 'pingresp') this.pendingAck?.(packet);
        if (packet.cmd === 'publish' && packet.qos === 0) options.onMessage?.(packet);
      },
      (error) => this.fail(error),
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
      (ack) => ack.cmd === 'connack',
    );
  }

  async subscribe(topic: string): Promise<void> {
    if (this.closing) throw new Error('Client is closing');
    const messageId = this.messageId === 65_535 ? 1 : this.messageId + 1;
    this.messageId = messageId;
    await this.exchange(
      { cmd: 'subscribe', messageId, subscriptions: [{ topic, qos: 0 }] },
      (ack) => ack.cmd === 'suback' && ack.messageId === messageId,
    );
  }

  async publish(topic: string, payload: string): Promise<void> {
    if (this.closing) throw new Error('Client is closing');
    await this.run(async () => this.transport.send({ cmd: 'publish', topic, payload, qos: 0, dup: false, retain: false }));
  }

  async ping(): Promise<void> {
    if (this.closing) throw new Error('Client is closing');
    await this.exchange({ cmd: 'pingreq' }, (ack) => ack.cmd === 'pingresp');
  }

  disconnect(): Promise<void> {
    this.closing ??= Promise.resolve().then(() => this.end());
    return this.closing;
  }

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

  private async exchange(packet: Packet, matches: (ack: Acknowledgment) => boolean): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.pendingAck) throw new Error('Another acknowledgment is pending');
    const ack = new Promise<Acknowledgment>((resolve) => {
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
      if (packet.cmd === 'pingreq' && !this.failure) {
        await this.abort(error instanceof Error ? error : new Error('MQTT ping failed')).catch(() => {});
      }
      throw error;
    } finally {
      this.pendingAck = undefined;
    }
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.failure) throw this.failure;
    let rejectOnClose!: (error: Error) => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      rejectOnClose = reject;
      this.pendingOperations.add(reject);
      timer = setTimeout(() => reject(new Error('MQTT operation timed out')), this.options.timeoutMs ?? 3000);
    });
    try {
      return await Promise.race([interrupted, operation()]);
    } finally {
      clearTimeout(timer);
      this.pendingOperations.delete(rejectOnClose);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const reject of this.pendingOperations) reject(error);
    this.unlisten?.();
  }
}

export async function connectPortable(transport: PacketTransport, options: PortableOptions) {
  const client = new PortableClient(transport, options);
  try {
    await client.open();
  } catch (error) {
    await client.abort(error instanceof Error ? error : new Error('MQTT connect failed')).catch(() => {});
    throw error;
  }
  return {
    subscribe: (topic: string) => client.subscribe(topic),
    publish: (topic: string, payload: string) => client.publish(topic, payload),
    ping: () => client.ping(),
    disconnect: () => client.disconnect(),
  };
}
