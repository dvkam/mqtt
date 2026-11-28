import type { ReadonlyBytes } from '../../dist/util/bytes.js';

type RequireTrue<Value extends true> = Value;
type Accepts<Value> = [Value] extends [ReadonlyBytes] ? true : false;
type Rejects<Value> = [Value] extends [ReadonlyBytes] ? false : true;

// A caller passes any Uint8Array without a conversion, whatever its buffer type.
export type AcceptsUint8Array = RequireTrue<Accepts<Uint8Array>>;
export type AcceptsReadonlyUint8Array = RequireTrue<Accepts<Readonly<Uint8Array>>>;
export type AcceptsOwnBuffer = RequireTrue<Accepts<Uint8Array<ArrayBuffer>>>;
export type AcceptsSharedBuffer = RequireTrue<Accepts<Uint8Array<SharedArrayBuffer>>>;
export type AcceptsNodeBuffer = RequireTrue<Accepts<Buffer>>;

// join in src/wireCodec.ts sizes a part by byteLength and copies it by element, so a wider element would encode wrong bytes.
export type RejectsUint16Array = RequireTrue<Rejects<Uint16Array>>;
export type RejectsFloat64Array = RequireTrue<Rejects<Float64Array>>;
export type RejectsUint8ClampedArray = RequireTrue<Rejects<Uint8ClampedArray>>;
export type RejectsDataView = RequireTrue<Rejects<DataView>>;
export type RejectsArrayLike = RequireTrue<
  Rejects<{ readonly [index: number]: number; readonly length: number; readonly byteLength: number }>
>;

// validateWillPayload in src/will.ts hands the bytes to TextDecoder.decode without a copy.
export type DecoderAcceptsIt = RequireTrue<ReadonlyBytes extends Parameters<TextDecoder['decode']>[0] ? true : false>;
