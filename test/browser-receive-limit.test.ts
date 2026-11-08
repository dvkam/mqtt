import { expect, test, vi } from 'vitest';
import { createBrowserClient } from '../src/browserClient.js';
import { PacketDecoder } from '../src/codec.js';
import { startReceivePeer } from './experiments/receive-peer.js';

test.each(['oversized-connect', 'suback-overflow', 'ping-overflow', 'partial-overflow', 'ws-fragments-overflow'])(
  '%s rejects before decoding and retains the receive error',
  async (mode) => {
    const peer = await startReceivePeer();
    const onMessage = vi.fn<(message: unknown) => void>();
    const push = vi.spyOn(PacketDecoder.prototype, 'push');
    try {
      const opening = createBrowserClient({
        url: peer.url + '/?mode=' + mode,
        clientId: mode,
        maxWebSocketMessageBytes: 8,
        maxPacketBytes: 8,
        onMessage,
      }).connect();
      let failure: unknown;
      let laterFailure: unknown;
      if (mode === 'oversized-connect') failure = await opening.catch((reason: unknown) => reason);
      else {
        const client = await opening;
        push.mockClear();
        const pending = mode === 'suback-overflow' ? client.subscribe('a') : client.ping();
        failure = await pending.catch((reason: unknown) => reason);
        laterFailure = await client.publish('a', 'late').catch((reason: unknown) => reason);
      }
      expect(laterFailure).toBe(mode === 'oversized-connect' ? undefined : failure);
      expect(failure).toBeInstanceOf(RangeError);
      expect(failure).toMatchObject({ message: 'WebSocket receive message limit exceeded' });
      expect(onMessage).not.toHaveBeenCalled();
      let largestDecodedMessage = 0;
      for (const [chunk] of push.mock.calls) largestDecodedMessage = Math.max(largestDecodedMessage, chunk.byteLength);
      expect(largestDecodedMessage).toBeLessThanOrEqual(8);
    } finally {
      push.mockRestore();
      await peer.close();
    }
  },
);

test.each(['exact', 'ws-fragments', 'mqtt-split', 'coalesced'])(
  '%s preserves independent WebSocket and MQTT boundaries',
  async (mode) => {
    const peer = await startReceivePeer();
    const messages: string[] = [];
    try {
      const client = await createBrowserClient({
        url: peer.url + '/?mode=' + mode,
        clientId: mode,
        maxWebSocketMessageBytes: mode === 'mqtt-split' ? 4 : mode === 'coalesced' ? 16 : 8,
        maxPacketBytes: 8,
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The public callback retains its native mutable payload contract.
        onMessage(message) {
          messages.push(new TextDecoder().decode(message.payload));
        },
      }).connect();
      await client.publish('a', 'test');
      await client.ping();
      expect(messages).toEqual(mode === 'coalesced' ? ['hi', 'hi'] : ['hi']);
      await client.disconnect();
    } finally {
      await peer.close();
    }
  },
);

test('an admitted WebSocket message still obeys the smaller MQTT packet allocation limit', async () => {
  const peer = await startReceivePeer();
  try {
    const client = await createBrowserClient({
      url: peer.url,
      clientId: 'packet-cap',
      maxWebSocketMessageBytes: 16,
      maxPacketBytes: 7,
    }).connect();
    await client.publish('a', 'test');
    await expect(client.ping()).rejects.toThrow('MQTT packet allocation limit exceeded');
  } finally {
    await peer.close();
  }
});
