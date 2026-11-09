export type ProtocolInputCode = 0x81 | 0x82;

export class ProtocolInputError extends Error {
  readonly code: ProtocolInputCode;

  constructor(message: string, code: ProtocolInputCode) {
    super(message);
    this.code = code;
  }
}
