import { isSubscriptionReason, type SubscriptionAckKind } from './subscriptionReason.js';
import { PacketIdentifiers, type IdentifierLease } from './packetIdentifiers.js';
import { MqttError } from './mqttError.js';
import { maxMqttPacketBytes, oversizedPacket } from './publicationAdmission.js';
import { copyUserProperties } from './userProperties.js';
import { utf8Length } from './util/utf8.js';
import type { UserProperty } from './wireProperties.js';

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
  requestedQos: 0 | 1 | 2;
  accepted: boolean;
  resolve: (acknowledgment: Acknowledgment) => void;
  reject: (reason: Readonly<Error>) => void;
}

type Metadata = Readonly<{ reasonString?: string; userProperties?: readonly UserProperty[] }>;
type Acknowledgment = Readonly<{ reasonCode: number }> & Metadata;
type Receipt = Readonly<{ cmd: SubscriptionAckKind; messageId?: number; granted: unknown }> & Metadata;

export class SubscriptionExchanges {
  private readonly limits: ReturnType<typeof resolveSubscriptionLimits>;
  private readonly entries = new Map<number, Entry>();
  private readonly identifiers: Readonly<Pick<PacketIdentifiers, 'reserve'>>;
  private bytes = 0;
  private maximumPacketSize = maxMqttPacketBytes;
  private failure?: Error;

  constructor(
    options: Readonly<SubscriptionLimits>,
    identifiers: Readonly<Pick<PacketIdentifiers, 'reserve'>> = new PacketIdentifiers(),
  ) {
    this.limits = resolveSubscriptionLimits(options);
    this.identifiers = identifiers;
  }

  limitPacketSize(maximumPacketSize: number): void {
    this.maximumPacketSize = Math.min(maximumPacketSize, maxMqttPacketBytes);
  }

  reserve(topic: string, kind: SubscriptionAckKind = 'suback', requestedQos: 0 | 1 | 2 = 0) {
    if (this.failure) throw this.failure;
    // Validation has already established valid Unicode and the MQTT string limit of 65,535 bytes.
    const remaining = (kind === 'suback' ? 6 : 5) + utf8Length(topic);
    let lengthBytes = 1;
    for (let value = remaining; value >= 128; value = Math.floor(value / 128)) lengthBytes++;
    const bytes = 1 + lengthBytes + remaining;
    if (bytes > this.maximumPacketSize) throw oversizedPacket();
    if (this.entries.size >= this.limits.maxPendingSubscriptions || bytes > this.limits.maxPendingSubscriptionBytes - this.bytes)
      throw new MqttError('ERR_MQTT_CAPACITY', 'MQTT subscription capacity exceeded');
    const identifier = this.identifiers.reserve();
    const { messageId } = identifier;
    let resolve!: Entry['resolve'];
    let reject!: Entry['reject'];
    const acknowledged = new Promise<Acknowledgment>((accept, refuse) => {
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

  accept(packet: Receipt): 0x81 | 0x82 | undefined {
    const { messageId, cmd: kind } = packet;
    if (messageId === undefined) return 0x81;
    if (!Number.isInteger(messageId) || messageId < 1 || messageId > 65_535) return 0x82;
    const entry = this.entries.get(messageId);
    if (!entry || entry.kind !== kind || entry.accepted) return undefined;
    entry.accepted = true;
    const { granted } = packet;
    if (!Array.isArray(granted) || granted.length === 0) return 0x81;
    if (granted.length !== 1) return 0x82;
    const code: unknown = granted[0];
    if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 255) return 0x81;
    if (!isSubscriptionReason(kind, code) || (kind === 'suback' && code <= 2 && code > entry.requestedQos)) return 0x82;
    if (code >= 128) {
      entry.resolve({ reasonCode: code });
      return undefined;
    }
    entry.resolve({
      reasonCode: code,
      reasonString: packet.reasonString,
      userProperties: kind === 'suback' ? copyUserProperties(packet.userProperties) : undefined,
    });
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
