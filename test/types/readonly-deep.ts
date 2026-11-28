import type { ReadonlyBytes, ReadonlyDeep } from '../../dist/util/bytes.js';
import type { ClientPacket, ReceivedPacket } from '../../dist/portable.js';
import type { ByteClientOptions, OpenContext } from '../../dist/index.js';

type RequireTrue<Value extends true> = Value;
type Accepts<Value> = [Value] extends [ReadonlyDeep<Value>] ? true : false;
type GivesBack<Value> = [ReadonlyDeep<Value>] extends [Value] ? true : false;

// A function that takes the read-only view accepts the writable value without a conversion.
export type AcceptsClientPacket = RequireTrue<Accepts<ClientPacket>>;
export type AcceptsReceivedPacket = RequireTrue<Accepts<ReceivedPacket>>;
export type AcceptsOptions = RequireTrue<Accepts<ByteClientOptions>>;
export type AcceptsOpenContext = RequireTrue<Accepts<OpenContext>>;

// A fixture that records the packet it was sent stores the view where the writable packet type is declared, without an assertion.
export type GivesBackClientPacket = RequireTrue<GivesBack<ClientPacket>>;
export type GivesBackReceivedPacket = RequireTrue<GivesBack<ReceivedPacket>>;

// A byte view at any depth becomes ReadonlyBytes, and a function keeps its type.
export type PayloadIsReadonlyBytes = RequireTrue<
  ReadonlyDeep<{ payload: Uint8Array }> extends { readonly payload: ReadonlyBytes } ? true : false
>;
type Callback = (length: number) => number;
export type FunctionKeepsItsType = RequireTrue<ReadonlyDeep<Callback> extends Callback ? true : false>;
