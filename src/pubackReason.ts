const codes = new Set([0, 16, 128, 131, 135, 144, 145, 151, 153]);

export function isPubackReason(code: number): boolean {
  return codes.has(code);
}

/**
 * MQTT 5 sections 3.4.2.1, 3.5.2.1, 3.6.2.1 and 3.7.2.1. PUBACK and PUBREC share one set of reason codes. PUBREL and
 * PUBCOMP carry 0, or 0x92 for a Packet Identifier the sender does not know.
 */
export function isAcknowledgmentReason(cmd: 'puback' | 'pubrec' | 'pubrel' | 'pubcomp', code: number): boolean {
  return cmd === 'puback' || cmd === 'pubrec' ? codes.has(code) : code === 0 || code === 0x92;
}
