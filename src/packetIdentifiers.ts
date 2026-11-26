import { MqttError } from './mqttError.js';

export interface IdentifierLease {
  readonly messageId: number;
  readonly release: () => void;
}

export class PacketIdentifiers {
  private readonly occupied = new Set<number>();
  private cursor = 0;

  reserve(): IdentifierLease {
    if (this.occupied.size === 65_535) throw new MqttError('ERR_MQTT_CAPACITY', 'MQTT packet identifiers exhausted');
    let messageId = this.cursor;
    do {
      messageId = messageId === 65_535 ? 1 : messageId + 1;
    } while (this.occupied.has(messageId));
    this.cursor = messageId;
    return this.claim(messageId);
  }

  /**
   * Lease `messageId`, which must be free. `reserve` leases the identifier it picks this way, and a resumed session
   * leases the identifier of each stored publication.
   */
  claim(messageId: number): IdentifierLease {
    this.occupied.add(messageId);
    let released = false;
    return {
      messageId,
      release: () => {
        if (released) return;
        released = true;
        this.occupied.delete(messageId);
      },
    };
  }
}
