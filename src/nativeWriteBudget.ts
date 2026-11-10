export type WriteTraffic = 'publication' | 'control';

export interface NativeWriteLimits {
  maxBufferedBytes?: number;
  reservedControlBytes?: number;
}

export function resolveNativeWriteLimits(options: Readonly<NativeWriteLimits>) {
  const { maxBufferedBytes = 1024 * 1024, reservedControlBytes = Math.min(128 * 1024, Math.floor(maxBufferedBytes / 4)) } = options;
  if (
    !Number.isSafeInteger(maxBufferedBytes) ||
    maxBufferedBytes <= 0 ||
    !Number.isSafeInteger(reservedControlBytes) ||
    reservedControlBytes < 0 ||
    reservedControlBytes > maxBufferedBytes
  ) {
    throw new RangeError('Native write limits require a positive safe budget and a reserve from zero through that budget');
  }
  return { maxBufferedBytes, reservedControlBytes };
}

export function allowsNativeWrite(
  limits: Readonly<ReturnType<typeof resolveNativeWriteLimits>>,
  bufferedBytes: number,
  messageBytes: number,
  traffic: WriteTraffic,
): boolean {
  if (!Number.isSafeInteger(bufferedBytes) || bufferedBytes < 0 || !Number.isSafeInteger(messageBytes) || messageBytes < 0)
    return false;
  switch (traffic) {
    case 'publication':
      return messageBytes <= limits.maxBufferedBytes - limits.reservedControlBytes - bufferedBytes;
    case 'control':
      return messageBytes <= limits.maxBufferedBytes - bufferedBytes;
    default:
      return false;
  }
}

// A rejection belongs to the exact object presented to the native admission gate.
const nativeBudgetFailures = new WeakMap<object, Readonly<Error>>();

export function recordNativeBudgetFailure<Failure extends Readonly<Error>>(attempt: object, failure: Failure): Failure {
  nativeBudgetFailures.set(attempt, failure);
  return failure;
}

export function takeNativeBudgetFailure(attempt: object, reason: unknown): Readonly<Error> | undefined {
  const recorded = nativeBudgetFailures.get(attempt);
  if (recorded === undefined || recorded !== reason) return undefined;
  nativeBudgetFailures.delete(attempt);
  return recorded;
}
