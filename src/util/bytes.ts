const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) ?? Uint8Array.prototype;
const arrayTag = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const arrayByteLength = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;

export const maxBinaryBytes = 65_535;

/**
 * A `Uint8Array` that the receiver only reads. `ByteInbound.bytes` takes it, so a transport may pass any `Uint8Array`,
 * a `Buffer` included, without a conversion. The type forbids writing an element through it. It does not freeze the
 * bytes, and `fill`, `set` and the other methods stay callable, so the receiver's promise not to write rests on its code.
 * `TextDecoder.decode` accepts it. `Readonly<Uint8Array>` alone fails prefer-readonly-parameter-types, because its
 * `buffer` keeps the writable buffer type.
 */
export type ReadonlyBytes = Readonly<Uint8Array<Readonly<ArrayBufferLike>>>;

/**
 * A view of `Value` for a function that only reads it, at every depth. A byte view becomes `ReadonlyBytes`, a function
 * keeps its type, and every other object gets read-only members. Every `Value` is assignable to it. It is internal and
 * no entry point exports it.
 *
 * Its limits:
 * - It forbids assignments and nothing else. A mutating method stays callable on the view, such as `Map.set`,
 *   `bytes.fill` or `socket.destroy`, so the annotation is true only where the function calls none.
 * - A view is assignable back to the writable type, so the compiler does not stop the function from handing the value
 *   to code that writes it.
 * - A `Buffer` and a view over its own `ArrayBuffer` both become `ReadonlyBytes`. The `Buffer` methods and the
 *   own-buffer type are gone.
 * - A class with private members loses them in the view, which is then not assignable back. Do not apply it to such a
 *   class.
 */
export type ReadonlyDeep<Value> = Value extends Uint8Array
  ? ReadonlyBytes
  : Value extends (...parameters: readonly never[]) => unknown
    ? Value
    : Value extends object
      ? { readonly [Key in keyof Value]: ReadonlyDeep<Value[Key]> }
      : Value;

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
