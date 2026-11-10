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

// The proof must outlive neither the failed attempt nor its error.
const nativeBudgetFailures = new WeakMap<Readonly<Error>, WeakSet<object>>();

export function recordNativeBudgetFailure<Failure extends Readonly<Error>>(attempt: object, failure: Failure): Failure {
  nativeBudgetFailures.set(failure, new WeakSet([attempt]));
  return failure;
}

export function takeNativeBudgetFailure(attempt: object, reason: unknown): Readonly<Error> | undefined {
  if (!(reason instanceof Error) || !nativeBudgetFailures.get(reason)?.has(attempt)) return undefined;
  nativeBudgetFailures.delete(reason);
  return reason;
}
