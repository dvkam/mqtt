import type { Packet } from 'mqtt-packet';
import { Readable } from 'stream';

export type PacketIdentifier = Readonly<Pick<Packet, 'messageId'>>;

/** Structural legacy storage contract. QoS storage flows are not implemented by the preview client. */
export interface PacketStore {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Custom stores receive and preserve caller-owned mutable packets.
  put(packet: Packet): Promise<unknown>;
  get(packet: PacketIdentifier): Promise<Packet>;
  del(packet: PacketIdentifier): Promise<Packet>;
  createStream(): Promise<Readable>;
  close(): Promise<void>;
}

const streamsOpts = { objectMode: true };
const defaultStoreOptions = {
  clean: true,
};

/**
 * In-memory implementation of the message store
 * This can actually be saved into files.
 *
 * @param {Object} [options] - store options
 */
export class Store implements PacketStore {
  private _inflights: Map<Packet['messageId'], Packet> | null;
  options: { clean?: boolean; [key: string]: unknown };

  constructor(options: Readonly<{ clean?: boolean; [key: string]: unknown }> = {}) {
    this.options = { ...options, defaultStoreOptions };
    this._inflights = new Map();
  }

  /**
   * Adds a packet to the store, a packet is
   * anything that has a messageId property.
   *
   */
  // oxlint-disable-next-line typescript/require-await, typescript/prefer-readonly-parameter-types -- Keep the promise API so store failures reject asynchronously. The store preserves the identity of mutable protocol packets.
  async put(packet: Readonly<Packet>): Promise<this> {
    if (this._inflights === null) throw new TypeError('Store is closed');
    this._inflights.set(packet.messageId, packet);
    return this;
  }

  /**
   * Creates a stream with all the packets in the store
   *
   */
  // oxlint-disable-next-line typescript/require-await -- Stream creation remains part of the existing promise API.
  async createStream() {
    if (this._inflights === null) throw new TypeError('Store is closed');
    const stream = new Readable(streamsOpts);
    let destroyed = false;
    const values: Packet[] = [];
    let packetIndex = 0;

    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The store preserves the identity of mutable protocol packets.
    this._inflights.forEach((value) => {
      values.push(value);
    });

    stream._read = function () {
      if (!destroyed && packetIndex < values.length) {
        this.push(values[packetIndex++]);
      } else {
        this.push(null);
      }
    };

    stream.destroy = function (_error?: Readonly<Error>): Readable {
      if (!destroyed) {
        destroyed = true;
        setTimeout(() => {
          this.emit('close');
        }, 0);
      }
      return stream;
    };

    return stream;
  }

  /**
   * deletes a packet from the store.
   */
  // oxlint-disable-next-line typescript/require-await -- Missing packets must reject through the existing promise API.
  async del(packet: PacketIdentifier): Promise<Packet> {
    if (this._inflights === null) throw new TypeError('Store is closed');
    const storedPacket = this._inflights.get(packet.messageId);
    if (storedPacket !== undefined) {
      this._inflights.delete(storedPacket.messageId);
      return storedPacket;
    } else {
      throw new Error('missing packet');
    }
  }

  /**
   * get a packet from the store.
   */
  // oxlint-disable-next-line typescript/require-await -- Missing packets must reject through the existing promise API.
  async get(packet: PacketIdentifier): Promise<Packet> {
    if (this._inflights === null) throw new TypeError('Store is closed');
    const storedPacket = this._inflights.get(packet.messageId);
    if (storedPacket !== undefined) {
      return storedPacket;
    } else {
      throw new Error('missing packet');
    }
  }

  /**
   * Close the store
   */
  // oxlint-disable-next-line typescript/require-await -- Preserve the existing asynchronous close contract.
  async close() {
    if (this.options.clean === true) {
      this._inflights = null;
    }
    return;
  }
}
