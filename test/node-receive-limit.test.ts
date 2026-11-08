import WebSocket from 'ws';
import { expect, test, vi } from 'vitest';
import { createWebSocketClient } from '../src/index.js';
import { startReceivePeer } from './experiments/receive-peer.js';

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, 4_294_967_296])(
  'Node rejects receive capacity %s before WebSocket construction',
  async (capacity) => {
    let accesses = 0;
    class ProbeURL extends URL {
      override get protocol(): string {
        accesses++;
        throw new Error('Unexpected WebSocket construction');
      }
    }
    await expect(
      createWebSocketClient({
        url: new ProbeURL('ws://localhost'),
        clientId: 'invalid-cap',
        maxWebSocketMessageBytes: capacity,
      }).connect(),
    ).rejects.toThrow(RangeError);
    expect(accesses).toBe(0);
  },
);

test.each([
  'oversized-connect',
  'suback-overflow',
  'ping-overflow',
  'partial-overflow',
  'ws-fragments-overflow',
  'stalled-close',
  'default-overflow',
])('Node %s rejects before MQTT decoding and retains the native receive error', async (mode) => {
  const peer = await startReceivePeer();
  const url = peer.url + '/?mode=' + mode;
  const emit = vi.spyOn(WebSocket.prototype, 'emit');
  const onMessage = vi.fn<(message: unknown) => void>();
  try {
    const opening = createWebSocketClient({
      url,
      clientId: mode,
      maxWebSocketMessageBytes: mode === 'default-overflow' ? undefined : 8,
      timeoutMs: 250,
      onMessage,
    }).connect();
    let failure: unknown;
    let later: unknown;
    const immediateFailures: Promise<unknown>[] = [];
    if (mode === 'oversized-connect') failure = await opening.catch((reason: unknown) => reason);
    else {
      const client = await opening;
      const owner: unknown = emit.mock.contexts.find((context: unknown) => context instanceof WebSocket && context.url === url);
      if (!(owner instanceof WebSocket)) throw new Error('Expected connected client socket');
      owner.once('error', () => {
        immediateFailures.push(client.subscribe('late').catch((reason: unknown) => reason));
      });
      emit.mockClear();
      failure = await (mode === 'suback-overflow' ? client.subscribe('a') : client.ping()).catch((reason: unknown) => reason);
      later = await client.publish('a', 'late').catch((reason: unknown) => reason);
    }
    expect(failure).toBeInstanceOf(RangeError);
    expect(await Promise.all(immediateFailures)).toEqual(mode === 'oversized-connect' ? [] : [failure]);
    expect(failure).toMatchObject({ code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' });
    expect(later).toBe(mode === 'oversized-connect' ? undefined : failure);
    expect(onMessage).not.toHaveBeenCalled();
    let messages = 0;
    for (let index = 0; index < emit.mock.calls.length; index++) {
      const owner: unknown = emit.mock.contexts[index];
      if (owner instanceof WebSocket && owner.url === url && emit.mock.calls[index]?.[0] === 'message') messages++;
    }
    expect(messages).toBe(mode === 'partial-overflow' ? 1 : 0);
    await vi.waitFor(() => {
      let readyState: number | undefined;
      for (const context of emit.mock.contexts) {
        const owner: unknown = context;
        if (owner instanceof WebSocket && owner.url === url) readyState = owner.readyState;
      }
      expect(readyState).toBe(WebSocket.CLOSED);
    });
  } finally {
    emit.mockRestore();
    await peer.close();
  }
});

test.each(['exact', 'ws-fragments', 'mqtt-split', 'coalesced'])(
  'Node %s preserves WebSocket-message boundaries independently of MQTT',
  async (mode) => {
    const peer = await startReceivePeer();
    const messages: string[] = [];
    try {
      const client = await createWebSocketClient({
        url: peer.url + '/?mode=' + mode,
        clientId: mode,
        maxWebSocketMessageBytes: mode === 'mqtt-split' ? 4 : mode === 'coalesced' ? 16 : 8,
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The callback exercises the public mutable Node Buffer payload.
        onMessage(packet) {
          messages.push(packet.payload.toString());
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
