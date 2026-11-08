export interface SubscriptionLimits {
  maxPendingSubscriptions?: number;
  maxPendingSubscriptionBytes?: number;
}

export function resolveSubscriptionLimits(options: Readonly<SubscriptionLimits>) {
  const { maxPendingSubscriptions = 32, maxPendingSubscriptionBytes = 1024 * 1024 } = options;
  if (
    !Number.isSafeInteger(maxPendingSubscriptions) ||
    maxPendingSubscriptions <= 0 ||
    maxPendingSubscriptions > 65_535 ||
    !Number.isSafeInteger(maxPendingSubscriptionBytes) ||
    maxPendingSubscriptionBytes <= 0
  )
    throw new RangeError('MQTT subscription limits require 1 through 65535 entries and positive safe bytes');
  return { maxPendingSubscriptions, maxPendingSubscriptionBytes };
}

interface Entry {
  bytes: number;
  resolve: (code: number | undefined) => void;
  reject: (reason: Readonly<Error>) => void;
}

export class SubscriptionExchanges {
  private readonly limits: ReturnType<typeof resolveSubscriptionLimits>;
  private readonly entries = new Map<number, Entry>();
  private bytes = 0;
  private cursor = 0;
  private failure?: Error;

  constructor(options: Readonly<SubscriptionLimits>) {
    this.limits = resolveSubscriptionLimits(options);
  }

  reserve(topic: string) {
    if (this.failure) throw this.failure;
    const available = this.limits.maxPendingSubscriptionBytes - this.bytes;
    if (this.entries.size >= this.limits.maxPendingSubscriptions) throw new RangeError('MQTT subscription capacity exceeded');
    // Validation has already established valid Unicode and the MQTT string limit.
    let remaining = 6;
    for (const character of topic) {
      const code = character.codePointAt(0)!;
      remaining += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (remaining > available) throw new RangeError('MQTT subscription capacity exceeded');
    }
    let lengthBytes = 1;
    for (let value = remaining; value >= 128; value = Math.floor(value / 128)) lengthBytes++;
    const bytes = 1 + lengthBytes + remaining;
    if (bytes > available) throw new RangeError('MQTT subscription capacity exceeded');
    let messageId = this.cursor;
    do {
      messageId = messageId === 65_535 ? 1 : messageId + 1;
    } while (this.entries.has(messageId));
    let resolve!: Entry['resolve'];
    let reject!: Entry['reject'];
    const acknowledged = new Promise<number | undefined>((accept, refuse) => {
      resolve = accept;
      reject = refuse;
    });
    const entry: Entry = { bytes, resolve, reject };
    this.entries.set(messageId, entry);
    this.cursor = messageId;
    this.bytes += bytes;
    return {
      messageId,
      acknowledged,
      release: () => {
        if (this.entries.get(messageId) !== entry) return;
        this.entries.delete(messageId);
        this.bytes -= entry.bytes;
      },
    };
  }

  accept(messageId: number | undefined, granted: readonly unknown[]): void {
    if (messageId === undefined) return;
    const entry = this.entries.get(messageId);
    if (!entry) return;
    const code = granted[0];
    entry.resolve(granted.length === 1 && typeof code === 'number' ? code : undefined);
  }

  retire(reason: Readonly<Error>): void {
    this.failure ??= reason;
    for (const entry of this.entries.values()) entry.reject(this.failure);
    this.entries.clear();
    this.bytes = 0;
  }
}
