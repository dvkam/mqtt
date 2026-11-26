import { MqttError } from './mqttError.js';
import { utf8Length } from './util/utf8.js';

export interface PublicationLimits {
  maxPendingPublishes?: number;
  maxPendingPublishBytes?: number;
}

export function resolvePublicationLimits(options: Readonly<PublicationLimits>) {
  const { maxPendingPublishes = 32, maxPendingPublishBytes = 1024 * 1024 } = options;
  if (
    !Number.isSafeInteger(maxPendingPublishes) ||
    maxPendingPublishes <= 0 ||
    !Number.isSafeInteger(maxPendingPublishBytes) ||
    maxPendingPublishBytes <= 0
  ) {
    throw new RangeError('MQTT publication limits must be positive safe integers');
  }
  return { maxPendingPublishes, maxPendingPublishBytes };
}

/** The largest packet MQTT can frame, with a four-byte Remaining Length of 268,435,455. */
export const maxMqttPacketBytes = 268_435_460;

export function oversizedPacket(): MqttError {
  return new MqttError('ERR_MQTT_CAPACITY', 'MQTT packet exceeds the Maximum Packet Size');
}

/**
 * The size of a PUBLISH: the first header byte, the Remaining Length, the topic with its length, the Packet Identifier
 * at QoS 1, the property section and the payload. `PublicationAdmission.reserve` counts the same bytes inline, so the
 * publish path makes no extra call. Counting stops once the topic passes `limit`.
 */
export function publishSize(
  topic: string,
  payloadBytes: number,
  propertyBytes: number,
  qos: 0 | 1,
  limit = Number.POSITIVE_INFINITY,
): number {
  const remaining = 2 + utf8Length(topic, limit) + (qos === 1 ? 2 : 0) + propertyBytes + payloadBytes;
  let lengthBytes = 1;
  for (let value = remaining; value >= 128; value = Math.floor(value / 128)) lengthBytes++;
  return 1 + lengthBytes + remaining;
}

export class PublicationAdmission {
  private readonly limits: ReturnType<typeof resolvePublicationLimits>;
  private items = 0;
  private bytes = 0;
  private maximumPacketSize = maxMqttPacketBytes;

  constructor(options: Readonly<PublicationLimits>) {
    this.limits = resolvePublicationLimits(options);
  }

  /** The byte limit for pending publications. A larger publication can never be admitted. */
  get byteLimit(): number {
    return this.limits.maxPendingPublishBytes;
  }

  /** The largest packet the client may send: the broker's Maximum Packet Size, or the largest packet MQTT can frame. */
  get packetLimit(): number {
    return this.maximumPacketSize;
  }

  limitPacketSize(maximumPacketSize: number): void {
    this.maximumPacketSize = Math.min(maximumPacketSize, maxMqttPacketBytes);
  }

  /**
   * `propertyBytes` is the encoded property section with its length. An empty section is one byte. A publication larger
   * than the packet limit rejects before the slot and byte checks, because no later retry can send it.
   */
  reserve(topic: string, payloadBytes: number, propertyBytes: number, qos: 0 | 1 = 0): () => void {
    const identifierBytes = qos === 1 ? 2 : 0;
    const remaining = 2 + utf8Length(topic, this.maximumPacketSize) + identifierBytes + propertyBytes + payloadBytes;
    let lengthBytes = 1;
    for (let value = remaining; value >= 128; value = Math.floor(value / 128)) lengthBytes++;
    const size = 1 + lengthBytes + remaining;
    if (size > this.maximumPacketSize) throw oversizedPacket();
    if (this.items >= this.limits.maxPendingPublishes || size > this.limits.maxPendingPublishBytes - this.bytes)
      throw new MqttError('ERR_MQTT_CAPACITY', 'MQTT publication capacity exceeded');
    this.items++;
    this.bytes += size;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.items--;
      this.bytes -= size;
    };
  }
}
