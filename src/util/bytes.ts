const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) ?? Uint8Array.prototype;
const arrayTag = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const arrayByteLength = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;

/** The largest MQTT Binary Data value, which has a two-byte length. */
export const maxBinaryBytes = 65_535;

/**
 * Copy `value` if it is a Uint8Array that fits MQTT Binary Data. The length comes from the typed array itself, so a
 * subclass that overrides `byteLength` cannot pass a larger array.
 */
export function copyBinaryData(value: unknown): Uint8Array<ArrayBuffer> | 'not bytes' | 'too long' {
  if (!isBytes(value)) return 'not bytes';
  const length: unknown = arrayByteLength?.call(value);
  // The TypedArray constructor copies through internal slots, not through getters a subclass overrides.
  return typeof length === 'number' && length <= maxBinaryBytes ? new Uint8Array(value) : 'too long';
}

function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && arrayTag?.call(value) === 'Uint8Array';
}
