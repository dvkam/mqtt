export interface IdentifierLease {
  readonly messageId: number;
  readonly release: () => void;
}

export class PacketIdentifiers {
  private readonly occupied = new Set<number>();
  private cursor = 0;

  reserve(): IdentifierLease {
    if (this.occupied.size === 65_535) throw new RangeError('MQTT packet identifiers exhausted');
    let messageId = this.cursor;
    do {
      messageId = messageId === 65_535 ? 1 : messageId + 1;
    } while (this.occupied.has(messageId));
    this.occupied.add(messageId);
    this.cursor = messageId;
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
