/*
 * Copyright (c) 2015-2015 MQTT.js contributors.
 * Copyright (c) 2011-2014 Adam Rudd.
 *
 * See LICENSE for more information
 */

import { MqttClient } from './client.js';
import type { ConnectOptions } from './interface/connectOptions.js';
import { protocols } from './util/constants.js';

import { URL } from 'url';

/**
 * connect()
 * Connect will:
 *   1) Validate the options provided by the user.
 *   2) Instantiate a new client.
 *   3) Return the client to the user.
 */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Legacy connect normalizes this object in place; #30 owns removing that mutation.
async function connect(options: ConnectOptions) {
  if (typeof options.brokerUrl === 'string') {
    options.brokerUrl = new URL(options.brokerUrl);
  }

  if (options.brokerUrl?.protocol === undefined || options.brokerUrl.protocol === '') {
    throw new Error(
      `Missing protocol. \
      To provide a protocol, you have two options:\
      - Format the brokerUrl with a protocol, for example: 'mqtt://test.mosquitto.org'.
      - Pass in the protocol via the protocol option.`,
    );
  }

  const validationErr: Error | undefined = _validateProtocol(options);
  if (validationErr) {
    throw validationErr;
  }

  const client = new MqttClient(options);
  await client.connect();
  return client;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- TLS options retain their native mutable certificate and key buffers.
function _validateProtocol(opts: Readonly<ConnectOptions>): Error | undefined {
  if (opts.tlsOptions && 'cert' in opts.tlsOptions && 'key' in opts.tlsOptions) {
    const urlProtocol = opts.brokerUrl?.protocol;
    if (urlProtocol !== undefined && urlProtocol !== '') {
      if (!protocols.secure.includes(urlProtocol)) {
        const protocolError: Error = formatSecureProtocolError(urlProtocol);
        return protocolError;
      }
    } else {
      // A cert and key was provided, however no protocol was specified, so we will throw an error.
      // Protocol normalization and this error contract are tracked in #30 and #52.
      return new Error('Missing secure protocol key');
    }
  }
  return undefined;
}

function formatSecureProtocolError(protocol: string): Error {
  let secureProtocol: string;
  switch (protocol) {
    case 'mqtt':
      secureProtocol = 'mqtts';
      break;
    case 'ws':
      secureProtocol = 'wss';
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
export { createTcpClient } from './tcpClient.js';
export { createWebSocketClient } from './websocketClient.js';
