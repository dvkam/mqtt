import type { ByteWriter } from '../../dist/index.js';
import { createBrowserClient } from '../../dist/browser.js';

type Same<Left, Right> =
  (<Value>(_value: Value) => Value extends Left ? 1 : 2) extends <Value>(_value: Value) => Value extends Right ? 1 : 2
    ? true
    : false;
type RequireTrue<Value extends true> = Value;
// The core hands the writer its encoded bytes by identity, so an adapter can pass them to a native API that keeps them.
export type WriterBytesAreWritable = RequireTrue<Same<Parameters<ByteWriter['write']>[0], Uint8Array<ArrayBuffer>>>;

export const browserFactory = createBrowserClient({
  url: 'wss://localhost/mqtt',
  clientId: 'mutable-consumer',
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  onMessage(message) {
    message.topic = 'consumer-normalized';
    message.payload = new Uint8Array();
  },
});
