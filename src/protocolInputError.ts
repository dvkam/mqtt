export type ProtocolInputCode = 0x81 | 0x82 | 0x94;

export class ProtocolInputError extends Error {
  readonly code: ProtocolInputCode;

  constructor(message: string, code: ProtocolInputCode) {
    super(message);
    this.code = code;
  }
}

export function isClientOnlyCommand(command: string): command is 'connect' | 'subscribe' | 'unsubscribe' | 'pingreq' {
  return command === 'connect' || command === 'subscribe' || command === 'unsubscribe' || command === 'pingreq';
}

export function brokerPacketDirectionError(command: string): ProtocolInputError {
  return new ProtocolInputError('Unexpected MQTT packet from broker: ' + command.toUpperCase(), 0x82);
}
