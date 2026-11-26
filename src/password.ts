import { MqttError } from './mqttError.js';
import { intrinsicByteLength, isBytes } from './util/bytes.js';

const passwordEncoder = new TextEncoder();
const maxPasswordBytes = 65_535;

function tooLong(): MqttError {
  return new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'MQTT password exceeds 65,535 bytes');
}

export function capturePassword(value: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (value === undefined) return undefined;
  if (isBytes(value)) {
    const length = intrinsicByteLength(value);
    if (typeof length !== 'number' || length > maxPasswordBytes) throw tooLong();
    return new Uint8Array(value);
  }
  if (typeof value !== 'string') throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'MQTT password must be a string or a Uint8Array');
  // A string with more code units than the limit cannot fit, so skip encoding it.
  if (value.length > maxPasswordBytes) throw tooLong();
  const bytes = passwordEncoder.encode(value);
  if (bytes.byteLength > maxPasswordBytes) throw tooLong();
  return bytes;
}
