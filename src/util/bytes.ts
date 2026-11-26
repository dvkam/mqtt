const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) ?? Uint8Array.prototype;
const arrayTag = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const arrayByteLength = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;

export function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && arrayTag?.call(value) === 'Uint8Array';
}

// A subclass can override the byteLength getter, so read the typed array's own length.
export function intrinsicByteLength(value: unknown): unknown {
  return arrayByteLength?.call(value);
}
