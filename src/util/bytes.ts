const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) ?? Uint8Array.prototype;
const arrayTag = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const arrayByteLength = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;

export const maxBinaryBytes = 65_535;

export function copyBinaryData(value: unknown): Uint8Array<ArrayBuffer> | 'not bytes' | 'too long' {
  if (!isBytes(value)) return 'not bytes';
  // The TypedArray constructor copies through internal slots, not through getters a subclass overrides.
  return ownByteLength(value) <= maxBinaryBytes ? new Uint8Array(value) : 'too long';
}

export function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && arrayTag?.call(value) === 'Uint8Array';
}

// A subclass can override the byteLength getter. Size checks read the typed array's own length instead.
export function ownByteLength(value: unknown): number {
  const length: unknown = arrayByteLength?.call(value);
  return typeof length === 'number' ? length : Number.POSITIVE_INFINITY;
}
