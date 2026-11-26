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

export class PublicationAdmission {
  private readonly limits: ReturnType<typeof resolvePublicationLimits>;
  private items = 0;
  private bytes = 0;

  constructor(options: Readonly<PublicationLimits>) {
    this.limits = resolvePublicationLimits(options);
  }

  /** The byte limit for pending publications. A larger publication can never be admitted. */
  get byteLimit(): number {
    return this.limits.maxPendingPublishBytes;
  }

  /** `propertyBytes` is the encoded property section with its length. An empty section is one byte. */
  reserve(topic: string, payloadBytes: number, propertyBytes: number, qos: 0 | 1 = 0): () => void {
    const available = this.limits.maxPendingPublishBytes - this.bytes;
    if (this.items >= this.limits.maxPendingPublishes)
      throw new MqttError('ERR_MQTT_CAPACITY', 'MQTT publication capacity exceeded');
    const identifierBytes = qos === 1 ? 2 : 0;
    const remaining = 2 + utf8Length(topic, available) + identifierBytes + propertyBytes + payloadBytes;
    let lengthBytes = 1;
    for (let value = remaining; value >= 128; value = Math.floor(value / 128)) lengthBytes++;
    const size = 1 + lengthBytes + remaining;
    if (remaining > 268_435_455 || size > available) throw new MqttError('ERR_MQTT_CAPACITY', 'MQTT publication capacity exceeded');
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
