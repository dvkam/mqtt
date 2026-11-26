/*
 * Copyright (c) 2015-2015 MQTT.js contributors.
 * Copyright (c) 2011-2014 Adam Rudd.
 *
 * See LICENSE for more information
 */

import type { ByteTransport } from './byteTransport.js';
import { nodePlatform } from './nodePlatform.js';
import type { ClientFactory } from './session.js';
import { createByteClient, type ByteClientOptions } from './transportCore.js';

export { createTcpClient } from './tcpClient.js';
export type { TcpClientOptions, TcpTlsOptions } from './tcpClient.js';
export type { ByteInbound, ByteTransport, ByteWriter, OpenContext } from './byteTransport.js';
export type { ByteClientOptions } from './transportCore.js';
export type {
  ClientFactory,
  ClientSession,
  PublishOptions,
  QosOneMessage,
  SessionEnd,
  SessionEndObserver,
  SubscribeOptions,
} from './session.js';
export type { NodeMessage, NodeQosOneMessage } from './nodeMessage.js';
export type { MessageProperties } from './messageProperties.js';
export type { UserProperty } from './codec.js';
export type { ClientDiagnostic, DiagnosticObserver } from './diagnostics.js';
export { MqttError, isMqttError } from './mqttError.js';
export type { MqttErrorCode, MqttErrorDetails } from './mqttError.js';

/** Create a one-shot MQTT client with Buffer payloads over a custom transport. */
export function createTransportClient(
  transport: Readonly<ByteTransport>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteClientOptions holds a native AbortSignal and Buffer callbacks, and Readonly<> cannot hide their mutable members. createByteClient in src/transportCore.ts takes the same type.
  options: Readonly<ByteClientOptions<Buffer>>,
): ClientFactory {
  return createByteClient(transport, options, nodePlatform);
}
