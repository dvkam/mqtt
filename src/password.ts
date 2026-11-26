import { MqttError } from './mqttError.js';
import { isBytes } from './util/bytes.js';

const passwordEncoder = new TextEncoder();
const maxPasswordBytes = 65_535;

function tooLong(): MqttError {
  return new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'MQTT password exceeds 65,535 bytes');
}

/**
 * Validate the CONNECT password before the transport opens and copy it, so a later change to the caller's bytes cannot
 * reach the wire. A string is sent as its UTF-8 bytes.
 */
export function capturePassword(value: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    // Each UTF-16 code unit encodes to at least one byte, so a longer string cannot fit.
    if (value.length > maxPasswordBytes) throw tooLong();
    const bytes = passwordEncoder.encode(value);
    if (bytes.byteLength > maxPasswordBytes) throw tooLong();
    return bytes;
  }
  if (!isBytes(value)) throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'MQTT password must be a string or a Uint8Array');
  if (value.byteLength > maxPasswordBytes) throw tooLong();
  return new Uint8Array(value);
}
