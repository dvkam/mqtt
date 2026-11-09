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

function utf8Bytes(value: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

export class PublicationAdmission {
  private readonly limits: ReturnType<typeof resolvePublicationLimits>;
  private items = 0;
  private bytes = 0;

  constructor(options: Readonly<PublicationLimits>) {
    this.limits = resolvePublicationLimits(options);
  }

  reserve(topic: string, payload: string, qos: 0 | 1 = 0): () => void {
    const available = this.limits.maxPendingPublishBytes - this.bytes;
    if (this.items >= this.limits.maxPendingPublishes) throw new RangeError('MQTT publication capacity exceeded');
    const identifierBytes = qos === 1 ? 2 : 0;
    const remaining = 3 + identifierBytes + utf8Bytes(topic, available) + utf8Bytes(payload, available);
    let lengthBytes = 1;
    for (let value = remaining; value >= 128; value = Math.floor(value / 128)) lengthBytes++;
    const size = 1 + lengthBytes + remaining;
    if (remaining > 268_435_455 || size > available) throw new RangeError('MQTT publication capacity exceeded');
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
