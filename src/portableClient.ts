import type { ByteTransport } from './byteTransport.js';
import { portablePlatform } from './portablePlatform.js';
import type { ClientFactory } from './session.js';
import { createByteClient, type ByteClientOptions } from './transportCore.js';

export type { PublishProperties } from './publication.js';
export type { ByteInbound, ByteTransport, ByteWriter, OpenContext } from './byteTransport.js';
export type { ReadonlyBytes } from './util/bytes.js';
export type { ByteClientOptions, SessionOptions } from './transportCore.js';
export { createSessionState } from './sessionState.js';
export type { SessionState } from './sessionState.js';
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
  QosTwoMessage,
  SessionEnd,
  SessionEndObserver,
  SubscribeOptions,
  SubscribeResult,
  UncertainPublication,
  UnsubscribeResult,
} from './session.js';
export { createReconnectingClient } from './reconnect.js';
export type {
  Reconnectable,
  ReconnectEvent,
  ReconnectingClient,
  ReconnectOptions,
  SubscriptionIntent,
  SubscriptionRestore,
} from './reconnect.js';
export type { BrokerPacket, ClientPacket } from './wireCodec.js';

/** Create a one-shot MQTT client with Uint8Array payloads over a custom transport. */
export function createTransportClient(
  transport: Readonly<ByteTransport>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `Readonly<ByteClientOptions>` still fails the rule, because the options hold an AbortSignal and a Will with byte views. `ReadonlyDeep` would pass, but it is an internal type, and this signature is public, so it names only exported types. Exporting the deep type is left to the owner.
  options: Readonly<ByteClientOptions>,
): ClientFactory {
  return createByteClient(transport, options, portablePlatform);
}
