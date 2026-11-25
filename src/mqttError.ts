import type { UserProperty } from './codec.js';

/** Stable reasons for an MQTT client rejection. Compare `error.code` instead of the message text. */
export type MqttErrorCode =
  | 'ERR_MQTT_CAPACITY'
  | 'ERR_MQTT_TIMEOUT'
  | 'ERR_MQTT_REFUSED'
  | 'ERR_MQTT_PROTOCOL'
  | 'ERR_MQTT_BROKER_DISCONNECT'
  | 'ERR_MQTT_CLOSING'
  | 'ERR_MQTT_INVALID_ARGUMENT';

export interface MqttErrorDetails {
  /** Whether the session ended. A rejection with `fatal: false` leaves an active session usable. */
  readonly fatal: boolean;
  /** The MQTT reason code the broker sent, or the one the client sent in DISCONNECT. */
  readonly reasonCode?: number;
  /** The MQTT 5 Reason String the broker sent. */
  readonly reasonString?: string;
  /** The MQTT 5 User Properties the broker sent, in wire order. */
  readonly userProperties?: readonly UserProperty[];
}

/** A client rejection with a stable `code`. */
export class MqttError extends Error {
  readonly code: MqttErrorCode;
  readonly fatal: boolean;
  readonly reasonCode?: number;
  readonly reasonString?: string;
  readonly userProperties?: readonly UserProperty[];

  constructor(code: MqttErrorCode, message: string, details: Readonly<MqttErrorDetails>) {
    super(message);
    this.name = 'MqttError';
    this.code = code;
    this.fatal = details.fatal;
    if (details.reasonCode !== undefined) this.reasonCode = details.reasonCode;
    if (details.reasonString !== undefined) this.reasonString = details.reasonString;
    if (details.userProperties !== undefined) this.userProperties = details.userProperties;
  }
}

/** Whether `error` is an `MqttError`, optionally with the given code. */
export function isMqttError(error: unknown, code?: MqttErrorCode): error is MqttError {
  return error instanceof MqttError && (code === undefined || error.code === code);
}
