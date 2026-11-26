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

// A later release can add a code. Checking for the codes a consumer handles keeps working when that happens.
export function retryable(error: unknown): boolean {
  if (isMqttError(error, 'ERR_MQTT_CAPACITY')) return !error.fatal;
  return isMqttError(error, 'ERR_MQTT_REFUSED') && error.reasonCode === 0x97;
}

export function brokerReason(error: unknown): string | undefined {
  return isMqttError(error, 'ERR_MQTT_BROKER_DISCONNECT') ? error.reasonString : undefined;
}

// @ts-expect-error The code is a closed union.
export const unknownCode: MqttErrorCode = 'ERR_MQTT_OTHER';
