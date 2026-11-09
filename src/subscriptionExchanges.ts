import { isSubscriptionReason, type SubscriptionAckKind } from './subscriptionReason.js';
import { PacketIdentifiers, type IdentifierLease } from './packetIdentifiers.js';

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
  identifier: IdentifierLease;
  kind: SubscriptionAckKind;
  requestedQos: 0 | 1;
  accepted: boolean;
  resolve: (code: number) => void;
  reject: (reason: Readonly<Error>) => void;
}

export class SubscriptionExchanges {
  private readonly limits: ReturnType<typeof resolveSubscriptionLimits>;
  private readonly entries = new Map<number, Entry>();
  private readonly identifiers: Readonly<Pick<PacketIdentifiers, 'reserve'>>;
  private bytes = 0;
  private failure?: Error;

  constructor(
    options: Readonly<SubscriptionLimits>,
    identifiers: Readonly<Pick<PacketIdentifiers, 'reserve'>> = new PacketIdentifiers(),
  ) {
    this.limits = resolveSubscriptionLimits(options);
    this.identifiers = identifiers;
  }

  reserve(topic: string, kind: SubscriptionAckKind = 'suback', requestedQos: 0 | 1 = 0) {
    if (this.failure) throw this.failure;
    const available = this.limits.maxPendingSubscriptionBytes - this.bytes;
    if (this.entries.size >= this.limits.maxPendingSubscriptions) throw new RangeError('MQTT subscription capacity exceeded');
    // Validation has already established valid Unicode and the MQTT string limit.
    let remaining = kind === 'suback' ? 6 : 5;
    for (const character of topic) {
      const code = character.codePointAt(0)!;
      remaining += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (remaining > available) throw new RangeError('MQTT subscription capacity exceeded');
    }
    let lengthBytes = 1;
    for (let value = remaining; value >= 128; value = Math.floor(value / 128)) lengthBytes++;
    const bytes = 1 + lengthBytes + remaining;
    if (bytes > available) throw new RangeError('MQTT subscription capacity exceeded');
    const identifier = this.identifiers.reserve();
    const { messageId } = identifier;
    let resolve!: Entry['resolve'];
    let reject!: Entry['reject'];
    const acknowledged = new Promise<number>((accept, refuse) => {
      resolve = accept;
      reject = refuse;
    });
    const entry: Entry = { bytes, identifier, kind, requestedQos, accepted: false, resolve, reject };
    this.entries.set(messageId, entry);
    this.bytes += bytes;
    return {
      messageId,
      acknowledged,
      release: () => {
        if (this.entries.get(messageId) !== entry) return;
        this.entries.delete(messageId);
        this.bytes -= entry.bytes;
        identifier.release();
      },
    };
  }

  accept(messageId: number | undefined, granted: unknown, kind: SubscriptionAckKind = 'suback'): 0x81 | 0x82 | undefined {
    if (messageId === undefined) return 0x81;
    if (!Number.isInteger(messageId) || messageId < 1 || messageId > 65_535) return 0x82;
    const entry = this.entries.get(messageId);
    if (!entry || entry.kind !== kind || entry.accepted) return undefined;
    if (!Array.isArray(granted) || granted.length === 0) return 0x81;
    if (granted.length !== 1) return 0x82;
    const code: unknown = granted[0];
    if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 255) return 0x81;
    if (!isSubscriptionReason(kind, code) || (kind === 'suback' && code <= 2 && code > entry.requestedQos)) return 0x82;
    entry.accepted = true;
    entry.resolve(code);
    return undefined;
  }

  retire(reason: Readonly<Error>): void {
    this.failure ??= reason;
    for (const entry of this.entries.values()) {
      entry.reject(this.failure);
      entry.identifier.release();
    }
    this.entries.clear();
    this.bytes = 0;
  }
}
