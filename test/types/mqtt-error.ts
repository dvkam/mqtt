import { isMqttError, MqttError, type MqttErrorCode } from '../../dist/index.js';

type RequireTrue<Value extends true> = Value;
type Same<Left, Right> =
  (<Value>(_value: Value) => Value extends Left ? 1 : 2) extends <Value>(_value: Value) => Value extends Right ? 1 : 2
    ? true
    : false;
type RequireFalse<Value extends false> = Value;

export type CodeIsAClosedUnion = RequireFalse<string extends MqttErrorCode ? true : false>;
export type ReasonCodeIsOptionalNumber = RequireTrue<MqttError['reasonCode'] extends number | undefined ? true : false>;

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

export function codeOf(error: unknown): 'capacity' | 'broker' | 'other' {
  if (!(error instanceof MqttError)) return 'other';
  if (error.code === 'ERR_MQTT_CAPACITY') {
    const narrowed: 'ERR_MQTT_CAPACITY' = error.code;
    void narrowed;
    return 'capacity';
  }
  return error.code === 'ERR_MQTT_BROKER_DISCONNECT' ? 'broker' : 'other';
}

declare const unknownError: unknown;
export const guarded = isMqttError(unknownError, 'ERR_MQTT_TIMEOUT') ? unknownError : undefined;
export type GuardNarrowsCode = RequireTrue<Same<NonNullable<typeof guarded>['code'], 'ERR_MQTT_TIMEOUT'>>;
export const anyMqttError = isMqttError(unknownError) ? unknownError : undefined;
export type GuardWithoutCodeKeepsUnion = RequireTrue<Same<NonNullable<typeof anyMqttError>['code'], MqttErrorCode>>;
