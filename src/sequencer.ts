import type { IConnackPacket, IConnectPacket, Packet } from 'mqtt-packet';

export class MqttPacketSequencer {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The sequencer forwards the original mutable protocol packet and credential buffers.
  private readonly send: (packet: Readonly<Packet>) => Promise<void>;
  private pendingConnect?: {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The sequencer forwards the original mutable protocol packet and credential buffers.
    resolve: (packet: Readonly<IConnackPacket>) => void;
    reject: (error: Readonly<Error>) => void;
  };

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The sequencer forwards the original mutable protocol packet and credential buffers.
  constructor(send: (packet: Readonly<Packet>) => Promise<void>) {
    this.send = send;
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The sequencer forwards the original mutable protocol packet and credential buffers.
  async connect(packet: Readonly<IConnectPacket>, timeout: number | undefined): Promise<IConnackPacket> {
    if (this.pendingConnect) throw new Error('CONNECT already in flight');

    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<IConnackPacket>((resolve, reject) => {
      this.pendingConnect = { resolve, reject };
    });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('connack packet timeout'));
      }, timeout);
    });
    try {
      const [connack] = await Promise.race([Promise.all([response, this.send(packet)]), deadline]);
      return connack;
    } finally {
      clearTimeout(timer);
      this.pendingConnect = undefined;
    }
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The sequencer forwards the original mutable protocol packet and credential buffers.
  handleIncomingPacket(packet: Readonly<Packet>): void {
    if (packet.cmd === 'connack') this.pendingConnect?.resolve(packet);
  }

  cancelConnect(error: Readonly<Error>): void {
    this.pendingConnect?.reject(error);
  }
}
