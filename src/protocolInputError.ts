import { MqttError } from './mqttError.ts';

export type ProtocolInputCode = 0x81 | 0x82 | 0x94;

/** Malformed or out-of-profile input from the broker. It ends the session, and `reasonCode` is the DISCONNECT reason. */
export class ProtocolInputError extends MqttError {
  declare readonly code: 'ERR_MQTT_PROTOCOL';
  declare readonly reasonCode: ProtocolInputCode;

  constructor(message: string, reasonCode: ProtocolInputCode) {
    super('ERR_MQTT_PROTOCOL', message, { reasonCode });
  }
}

export function brokerPacketDirectionError(command: string): ProtocolInputError {
  return new ProtocolInputError('Unexpected MQTT packet from broker: ' + command.toUpperCase(), 0x82);
}
