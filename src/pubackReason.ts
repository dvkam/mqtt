const codes = new Set([0, 16, 128, 131, 135, 144, 145, 151, 153]);

export function isPubackReason(code: number): boolean {
  return codes.has(code);
}
