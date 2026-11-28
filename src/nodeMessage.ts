import type { PublishMessage } from './messageProperties.js';
import type { QosOneMessage, QosTwoMessage } from './session.js';

export type NodeMessage = PublishMessage<Buffer>;

export type NodeQosOneMessage = QosOneMessage<NodeMessage>;

/** A received QoS 2 PUBLISH on Node, with a Buffer payload. */
export type NodeQosTwoMessage = QosTwoMessage<NodeMessage>;

/** View decoded bytes as a Buffer without copying. The decoder's packet allocation is already a Buffer. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers.
export function nodeBytes(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
