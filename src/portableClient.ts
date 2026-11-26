import type { ByteTransport } from './byteTransport.js';
import { portablePlatform } from './portablePlatform.js';
import type { ClientFactory } from './session.js';
import { createByteClient, type ByteClientOptions } from './transportCore.js';

export type { PublishProperties } from './publication.js';
export type { ByteInbound, ByteTransport, ByteWriter, OpenContext } from './byteTransport.js';
export type { ByteClientOptions } from './transportCore.js';
export type { WillOptions } from './will.js';
export type { ClientDiagnostic, DiagnosticObserver } from './diagnostics.js';
export { MqttError, isMqttError } from './mqttError.js';
export type { MqttErrorCode, MqttErrorDetails } from './mqttError.js';
export type { MessageProperties, PublishMessage } from './messageProperties.js';
export type { ReceivedPacket } from './portable.js';
export { ProtocolInputError } from './protocolInputError.js';
export type { ProtocolInputCode } from './protocolInputError.js';
export type {
  ClientFactory,
  ClientSession,
  ConnectionInfo,
  DisconnectOptions,
  PublishOptions,
  QosOneMessage,
  SessionEnd,
  SessionEndObserver,
  SubscribeOptions,
  SubscribeResult,
  UnsubscribeResult,
} from './session.js';
export type { BrokerPacket, ClientPacket } from './wireCodec.js';

/** Create a one-shot MQTT client with Uint8Array payloads over a custom transport. */
export function createTransportClient(
  transport: Readonly<ByteTransport>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteClientOptions holds a native AbortSignal and Uint8Array callbacks, and Readonly<> cannot hide their mutable members. createByteClient in src/transportCore.ts takes the same type.
  options: Readonly<ByteClientOptions>,
): ClientFactory {
  return createByteClient(transport, options, portablePlatform);
}
