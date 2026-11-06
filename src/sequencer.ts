import type { IConnackPacket, IConnectPacket, Packet } from 'mqtt-packet';

export class MqttPacketSequencer {
  private pendingConnect?: {
    resolve: (packet: IConnackPacket) => void;
    reject: (error: Error) => void;
  };

  constructor(private readonly send: (packet: Packet) => Promise<void>) {}

  async connect(packet: IConnectPacket, timeout: number): Promise<IConnackPacket> {
    if (this.pendingConnect) throw new Error('CONNECT already in flight');

    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<IConnackPacket>((resolve, reject) => {
      this.pendingConnect = { resolve, reject };
    });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('connack packet timeout')), timeout);
    });
    try {
      const [connack] = await Promise.race([Promise.all([response, this.send(packet)]), deadline]);
      return connack;
    } finally {
      clearTimeout(timer);
      this.pendingConnect = undefined;
    }
  }

  handleIncomingPacket(packet: Packet): void {
    if (packet.cmd === 'connack') this.pendingConnect?.resolve(packet);
  }

  cancelConnect(error: Error): void {
    this.pendingConnect?.reject(error);
  }
}
