export type SubscriptionAckKind = 'suback' | 'unsuback';

const subackCodes = new Set([0, 1, 2, 128, 131, 135, 143, 145, 151, 158, 161, 162]);
const unsubackCodes = new Set([0, 17, 128, 131, 135, 143, 145]);

export function isSubscriptionReason(kind: SubscriptionAckKind, code: unknown): code is number {
  return typeof code === 'number' && (kind === 'suback' ? subackCodes : unsubackCodes).has(code);
}
