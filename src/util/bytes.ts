const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) ?? Uint8Array.prototype;
const arrayTag = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;

/** Whether `value` is a Uint8Array, including a subclass or one from another realm. */
export function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && arrayTag?.call(value) === 'Uint8Array';
}
