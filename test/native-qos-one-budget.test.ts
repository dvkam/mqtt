import { expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createBrowserClient } from '../src/browserClient.js';
import { createWebSocketClient } from '../src/websocketClient.js';
import { openBrowserTransport } from '../src/browserTransport.js';
import { startProtocolPeer } from './experiments/protocol-peer.js';

test.each(['node-websocket', 'browser'] as const)(
  '%s keeps a session active after rejecting an unsent QoS 1 publish',
  async (adapter) => {
    const broker = await startProtocolPeer(1);
    try {
      const options = {
        url: broker.url,
        clientId: 'qos-budget',
        maxBufferedBytes: 64,
        reservedControlBytes: 16,
        maxPendingPublishes: 1,
      };
      const factory = adapter === 'browser' ? createBrowserClient(options) : createWebSocketClient(options);
      const client = await factory.connect();
      const prototype = adapter === 'browser' ? globalThis.WebSocket.prototype : WebSocket.prototype;
      const buffered = vi.spyOn(prototype, 'bufferedAmount', 'get').mockReturnValue(48);
      try {
        await expect(client.publish('a', 'refused', { qos: 1 })).rejects.toThrow('WebSocket write budget exceeded');
        await client.ping();
        expect(broker.commands).toEqual(['connect', 'pingreq']);
        buffered.mockReturnValue(0);
        await client.publish('a', 'accepted', { qos: 1 });
        await client.disconnect();
        expect(broker.commands).toEqual(['connect', 'pingreq', 'publish', 'disconnect']);
      } finally {
        buffered.mockRestore();
      }
    } finally {
      await broker.close();
    }
  },
);

test('a budget error from an earlier byte view cannot classify another send as unsent', async () => {
  const broker = await startProtocolPeer();
  try {
    const raw = await openBrowserTransport(broker.url, { maxBufferedBytes: 1, onBytes() {}, onClose() {} });
    let saved: unknown;
    try {
      raw.send(Uint8Array.of(1, 2), 'publication');
    } catch (reason) {
      saved = reason;
    } finally {
      await raw.close();
    }
    expect(saved).toBeInstanceOf(Error);
    const client = await createBrowserClient({ url: broker.url, clientId: 'stale-budget-error' }).connect();
    const send = vi.spyOn(globalThis.WebSocket.prototype, 'send').mockImplementationOnce(() => {
      throw saved;
    });
    try {
      await expect(client.publish('a', 'uncertain', { qos: 1 })).rejects.toBe(saved);
      await expect(client.ping()).rejects.toBe(saved);
    } finally {
      send.mockRestore();
    }
  } finally {
    await broker.close();
  }
});
