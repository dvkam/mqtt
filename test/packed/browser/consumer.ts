import { createBrowserClient } from 'mqtt/browser';
import type { BrowserClientOptions, BrowserSession, ClientFactory, ClientSession } from 'mqtt/browser';

type RequireTrue<Value extends true> = Value;
type RequireFalse<Value extends false> = Value;
type IsAny<Value> = 0 extends 1 & Value ? true : false;
type Received = Parameters<NonNullable<BrowserClientOptions['onMessage']>>[0];
export type PackedPayloadIsSpecific = RequireFalse<IsAny<Received['payload']>>;
export type PackedPayloadIsBytes = RequireTrue<Received['payload'] extends Uint8Array ? true : false>;
export type PackedQosIsZero = RequireTrue<Received['qos'] extends 0 ? true : false>;
export type PackedSessionIsCommon = RequireTrue<BrowserSession extends ClientSession ? true : false>;
export type BrowserOwnsTls = RequireTrue<
  Extract<'ca' | 'cert' | 'key' | 'agent', keyof BrowserClientOptions> extends never ? true : false
>;

const options: BrowserClientOptions = {
  url: 'wss://localhost/mqtt',
  clientId: 'packed-browser-types',
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The consumer verifies the original mutable Uint8Array callback contract.
  onMessage(message) {
    const bytes: Uint8Array = message.payload;
    bytes[0] = message.qos;
  },
};
export const factory: ClientFactory = createBrowserClient(options);
