// The ws client on the byte transport core. The first block pins what changed from the ws client on main, as listed in
// docs/byte-transport.md. The second pins behavior the move had to keep.
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createWebSocketClient } from '../src/ws.js';

const options = { url: 'ws://127.0.0.1:9/mqtt', clientId: 'core-changes' };
const connack = Buffer.of(0x20, 0x03, 0x00, 0x00, 0x00);

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The peer drives native ws sockets and requests.
type OnConnect = (socket: WebSocket, request: IncomingMessage) => void;
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ws passes its own Set of offered subprotocols.
type SelectProtocol = (offered: Set<string>) => string | false;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ws passes its own Set of offered subprotocols.
const selectMqtt: SelectProtocol = (offered) => offered.has('mqtt') && 'mqtt';

/** A WebSocket peer that speaks the mqtt subprotocol and hands each socket to `onConnect` after the client's CONNECT. */
async function peer(onConnect: OnConnect, protocols: SelectProtocol = selectMqtt) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: protocols });
  let connections = 0;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The peer drives native ws sockets and requests.
  server.on('connection', (socket, request) => {
    connections++;
    socket.on('error', () => {});
    socket.once('message', () => {
      onConnect(socket, request);
    });
  });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  return {
    url: 'ws://127.0.0.1:' + String(address.port) + '/mqtt',
    connections: () => connections,
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

describe('changes from the ws client on main', () => {
  test('an abort whose reason is not an Error names the WebSocket transport', async () => {
    const controller = new AbortController();
    controller.abort('stop');
    await expect(createWebSocketClient({ ...options, signal: controller.signal }).connect()).rejects.toMatchObject({
      name: 'AbortError',
      message: 'WebSocket connection aborted',
      code: 'ERR_MQTT_ABORTED',
    });
  });

  test('the core validates the timeout before the write limits', async () => {
    await expect(createWebSocketClient({ ...options, timeoutMs: 0, maxBufferedBytes: 0 }).connect()).rejects.toThrow(
      'MQTT timeout must be a positive integer and fit in a timer',
    );
  });

  test('the core validates the packet limit before the WebSocket message limit', async () => {
    await expect(createWebSocketClient({ ...options, maxPacketBytes: 1, maxWebSocketMessageBytes: 0 }).connect()).rejects.toThrow(
      'MQTT packet capacity must be an integer from 2 to 268435460',
    );
  });

  test('a failed attempt reports its first failure even when the caller aborts afterwards', async () => {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The peer drives native ws sockets and requests.
    const server = await peer((socket) => {
      socket.send('text');
    });
    const controller = new AbortController();
    try {
      await expect(
        createWebSocketClient({
          url: server.url,
          clientId: 'late-abort',
          signal: controller.signal,
          onSessionEnd() {
            controller.abort(new Error('late abort'));
          },
        }).connect(),
      ).rejects.toThrow('MQTT WebSocket requires binary messages');
    } finally {
      await server.close();
    }
  });

  test('a write over the budget on a closing socket reports the budget refusal', async () => {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The peer drives native ws sockets and requests.
    const server = await peer((socket, request) => {
      // Send the close frame right behind CONNACK, then stop reading so the client stays in the closing handshake.
      socket.send(connack);
      socket.close(1000);
      request.socket.pause();
    });
    try {
      const client = await createWebSocketClient({
        url: server.url,
        clientId: 'closing-budget',
        maxBufferedBytes: 64,
        reservedControlBytes: 0,
      }).connect();
      await sleep(80);
      await expect(client.publish('t', 'x'.repeat(200))).rejects.toThrow('WebSocket write budget exceeded');
    } finally {
      await server.close();
    }
  });
});

describe('behavior the ws client keeps on the core', () => {
  test('an invalid WebSocket message limit rejects before any socket opens', async () => {
    const server = await peer(() => {});
    try {
      await expect(
        createWebSocketClient({ url: server.url, clientId: 'limit', maxWebSocketMessageBytes: 0 }).connect(),
      ).rejects.toThrow('WebSocket receive message limit must be an integer from 1 to 2147483647');
      await sleep(50);
      expect(server.connections()).toBe(0);
    } finally {
      await server.close();
    }
  });

  test('a peer that does not select the mqtt subprotocol is refused during the handshake', async () => {
    const server = await peer(
      () => {},
      () => false,
    );
    try {
      await expect(createWebSocketClient({ url: server.url, clientId: 'subprotocol' }).connect()).rejects.toThrow(
        'Server sent no subprotocol',
      );
    } finally {
      await server.close();
    }
  });

  test('a text frame during a graceful close ends the close at once', async () => {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The peer drives native ws sockets and requests.
    const server = await peer((socket, request) => {
      socket.send(connack);
      // Stop reading so the client's closing handshake gets no answer, then send a text frame.
      request.socket.pause();
      setTimeout(() => {
        socket.send('text');
      }, 100);
    });
    try {
      const client = await createWebSocketClient({ url: server.url, clientId: 'graceful', timeoutMs: 2000 }).connect();
      const started = performance.now();
      await client.disconnect();
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      await server.close();
    }
  });
});
