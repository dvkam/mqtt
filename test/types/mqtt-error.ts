import { isMqttError, MqttError, type MqttErrorCode } from '../../dist/index.js';
import { MqttError as BrowserMqttError } from '../../dist/browser.js';
import { MqttError as PortableMqttError } from '../../dist/portableClient.js';

type RequireTrue<Value extends true> = Value;
type RequireFalse<Value extends false> = Value;

export type CodeIsAClosedUnion = RequireFalse<string extends MqttErrorCode ? true : false>;
export type ReasonCodeIsOptionalNumber = RequireTrue<MqttError['reasonCode'] extends number | undefined ? true : false>;
export type EntriesShareOneClass = RequireTrue<
  typeof BrowserMqttError extends typeof MqttError ? (typeof PortableMqttError extends typeof MqttError ? true : false) : false
>;

export function retryable(error: unknown): boolean {
  if (!(error instanceof MqttError)) return false;
  switch (error.code) {
    case 'ERR_MQTT_CAPACITY':
      return !error.fatal;
    case 'ERR_MQTT_REFUSED':
      return error.reasonCode === 0x97;
    case 'ERR_MQTT_TIMEOUT':
    case 'ERR_MQTT_PROTOCOL':
    case 'ERR_MQTT_BROKER_DISCONNECT':
    case 'ERR_MQTT_CLOSING':
    case 'ERR_MQTT_TRANSPORT':
    case 'ERR_MQTT_ABORTED':
    case 'ERR_MQTT_INVALID_ARGUMENT':
      return false;
    default: {
      const unhandled: never = error.code;
      return unhandled;
    }
  }
}

export function brokerReason(error: unknown): string | undefined {
  return isMqttError(error, 'ERR_MQTT_BROKER_DISCONNECT') ? error.reasonString : undefined;
}

// @ts-expect-error The code is a closed union.
export const unknownCode: MqttErrorCode = 'ERR_MQTT_OTHER';
