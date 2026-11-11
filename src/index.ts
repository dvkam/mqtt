/*
 * Copyright (c) 2015-2015 MQTT.js contributors.
 * Copyright (c) 2011-2014 Adam Rudd.
 *
 * See LICENSE for more information
 */

import { MqttClient } from './client.js';
import type { ConnectInput, ConnectOptions } from './interface/connectOptions.js';

/**
 * connect()
 * Connect will:
 *   1) Validate the options provided by the user.
 *   2) Instantiate a new client.
 *   3) Return the client to the user.
 */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native credential buffers and custom stream factories retain their mutable types. The frozen-input regression verifies that normalization leaves the caller's options intact.
async function connect(options: Readonly<ConnectInput>) {
  const { brokerUrl: endpoint, ...connectionOptions } = options;
  const address = typeof endpoint === 'string' ? endpoint : endpoint?.href;
  let brokerUrl: URL | undefined;
  try {
    if (address !== undefined) brokerUrl = new URL(address);
  } catch {
    throw new Error('Invalid broker URL');
  }
  if (brokerUrl === undefined || brokerUrl.protocol === '') throw new Error('Missing broker URL protocol');

  const normalized: ConnectOptions = { ...connectionOptions, brokerUrl };
  const tlsOptions = normalized.tlsOptions;
  if (tlsOptions && 'cert' in tlsOptions && 'key' in tlsOptions && !['mqtts:', 'tls:', 'wss:'].includes(brokerUrl.protocol)) {
    throw formatSecureProtocolError(brokerUrl.protocol);
  }

  const client = new MqttClient(normalized);
  await client.connect();
  return client;
}

function formatSecureProtocolError(protocol: string): Error {
  let secureProtocol: string;
  switch (protocol) {
    case 'mqtt:':
      secureProtocol = 'mqtts:';
      break;
    case 'tcp:':
      secureProtocol = 'tls:';
      break;
    case 'ws:':
      secureProtocol = 'wss:';
      break;
    default:
      return new Error('Unknown protocol for secure connection: "' + protocol + '"!');
  }
  return new Error(
    `user provided cert and key , but protocol ${protocol} is insecure. 
    Use ${secureProtocol} instead.`,
  );
}

export { connect };
export type { ConnectInput, ConnectOptions, LegacyAckCompletion, LegacyAckHandler } from './interface/connectOptions.js';
export type { PacketIdentifier, PacketLookup, PacketStore } from './store.js';
export { createTcpClient } from './tcpClient.js';
export { createWebSocketClient } from './websocketClient.js';
export type { TcpClientOptions } from './tcpClient.js';
export type { WebSocketClientOptions } from './websocketClient.js';
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
export type { ClientDiagnostic, DiagnosticObserver } from './diagnostics.js';
