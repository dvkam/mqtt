const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) ?? Uint8Array.prototype;
const arrayTag = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const arrayByteLength = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;

export const maxBinaryBytes = 65_535;

/**
 * A Uint8Array that a function only reads. Every Uint8Array is assignable to it, and `TextDecoder.decode` accepts it.
 * `Readonly<Uint8Array>` alone fails prefer-readonly-parameter-types, because its `buffer` keeps the writable buffer type.
 */
export type ReadonlyBytes = Readonly<Uint8Array<Readonly<ArrayBufferLike>>>;

export function copyBinaryData(value: unknown): Uint8Array<ArrayBuffer> | 'not bytes' | 'too long' {
  if (!isBytes(value)) return 'not bytes';
  // The TypedArray constructor copies through internal slots, not through getters a subclass overrides.
  return ownByteLength(value) <= maxBinaryBytes ? new Uint8Array(value) : 'too long';
}

export function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && arrayTag?.call(value) === 'Uint8Array';
}

/**
 * The length of a Uint8Array as its internal slot holds it, because a subclass can override the byteLength getter.
 * Infinity for any other value, so a size check rejects it.
 */
export function ownByteLength(value: unknown): number {
  if (!isBytes(value)) return Number.POSITIVE_INFINITY;
  const length: unknown = arrayByteLength?.call(value);
  return typeof length === 'number' ? length : Number.POSITIVE_INFINITY;
}

/** The size of an MQTT Variable Byte Integer for a value from 0 to 268,435,455. */
export function variableByteIntegerSize(value: number): number {
  return value < 128 ? 1 : value < 16_384 ? 2 : value < 2_097_152 ? 3 : 4;
}
