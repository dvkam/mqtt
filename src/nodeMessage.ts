import type { PublishMessage } from './messageProperties.js';
import type { QosOneMessage, QosTwoMessage } from './session.js';

export type NodeMessage = PublishMessage<Buffer>;

export type NodeQosOneMessage = QosOneMessage<NodeMessage>;

/** A received QoS 2 PUBLISH on Node, with a Buffer payload. */
export type NodeQosTwoMessage = QosTwoMessage<NodeMessage>;

/** View decoded bytes as a Buffer without copying. The decoder's packet allocation is already a Buffer. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `nodeBytes` returns the memory of `bytes` as the `Buffer` payload that the application owns and may write (the handlers in test/types/public-client-types.ts fill it). A read-only parameter type would be false for bytes that are handed on as writable.
export function nodeBytes(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
