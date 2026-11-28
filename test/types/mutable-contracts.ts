import type { ByteWriter } from '../../dist/index.js';
import type { PacketTransport } from '../../dist/portable.js';
import { createBrowserClient } from '../../dist/browser.js';

type Same<Left, Right> =
  (<Value>(_value: Value) => Value extends Left ? 1 : 2) extends <Value>(_value: Value) => Value extends Right ? 1 : 2
    ? true
    : false;
type RequireTrue<Value extends true> = Value;
type PacketListener = Parameters<PacketTransport['listen']>[0];
type PacketCloseListener = Parameters<PacketTransport['listen']>[1];
type Publish = Extract<Parameters<PacketListener>[0], { cmd: 'publish' }>;
export type PacketTopicIsWritable = RequireTrue<Same<Pick<Publish, 'topic'>, { topic: string }>>;
export type PacketErrorMessageIsWritable = RequireTrue<
  Same<Pick<Parameters<PacketCloseListener>[0], 'message'>, { message: string }>
>;

// The core hands the writer its encoded bytes by identity, so an adapter can pass them to a native API that keeps them.
export type WriterBytesAreWritable = RequireTrue<Same<Parameters<ByteWriter['write']>[0], Uint8Array<ArrayBuffer>>>;

export const packetTransport: PacketTransport = {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The assignment below checks that packed transport adapters can replace the payload.
  async send(packet) {
    const admitted = await Promise.resolve(packet);
    if (admitted.cmd === 'publish') admitted.payload = new Uint8Array();
  },
  listen(_receive, onClose) {
    const error = new Error('transport failure');
    onClose(error);
    return () => {};
  },
  async close() {},
};

export const browserFactory = createBrowserClient({
  url: 'wss://localhost/mqtt',
  clientId: 'mutable-consumer',
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  onMessage(message) {
    message.topic = 'consumer-normalized';
    message.payload = new Uint8Array();
  },
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Developer experience: this handler is the evidence that an application may write a QoS 2 message, which the suppression on onQosTwoMessage in src/portable.ts cites. A readonly parameter could not make these assignments.
  onQosTwoMessage(message) {
    message.payload = new Uint8Array();
    message.messageId = 0;
  },
});
