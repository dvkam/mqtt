import { MqttError } from './mqttError.js';
import { copyBinaryData, maxBinaryBytes } from './util/bytes.js';

const passwordEncoder = new TextEncoder();

function tooLong(): MqttError {
  return new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'MQTT password exceeds 65,535 bytes');
}

export function capturePassword(value: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value.length > maxBinaryBytes) throw tooLong();
    const bytes = passwordEncoder.encode(value);
    if (bytes.byteLength > maxBinaryBytes) throw tooLong();
    return bytes;
  }
  const copy = copyBinaryData(value);
  if (copy === 'too long') throw tooLong();
  if (copy === 'not bytes') throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'MQTT password must be a string or a Uint8Array');
  return copy;
}
