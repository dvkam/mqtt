// Read on first use, so an AbortSignal polyfill installed after this module loads is still found.
let abortedGetter: (() => unknown) | undefined;

/**
 * Whether `value` is an AbortSignal. The `aborted` getter checks the internal brand, so a signal from another realm, such as
 * an iframe, passes and an object that only looks like a signal does not.
 */
export function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null) return false;
  abortedGetter ??=
    typeof AbortSignal === 'function' ? Reflect.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get : undefined;
  if (abortedGetter === undefined) return false;
  try {
    abortedGetter.call(value);
    return true;
  } catch {
    return false;
  }
}
