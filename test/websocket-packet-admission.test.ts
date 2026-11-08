import { expect, test, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import WebSocket from 'ws';
import { createWebSocketClient } from '../src/index.js';
import { NodePacketDecoder } from '../src/nodePacketDecoder.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

test.each([0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 268_435_461])(
  'WS rejects packet capacity %s before URL access',
  async (maxPacketBytes) => {
    let accesses = 0;
    await expect(
      createWebSocketClient({
        get url(): string {
          accesses++;
          throw new Error('Unexpected WebSocket construction');
        },
        clientId: 'invalid-packet-cap',
        maxPacketBytes,
      }).connect(),
    ).rejects.toBeInstanceOf(RangeError);
    expect(accesses).toBe(0);
  },
);

test.each(['limit-connect', 'prefix-connect'])('WS %s rejects opening from the declaration alone', async (mode) => {
  const peer = await startWebSocketPacketPeer(mode);
  try {
    await expect(createWebSocketClient({ ...peer, clientId: mode, maxPacketBytes: 8, timeoutMs: 200 }).connect()).rejects.toThrow(
      'MQTT packet allocation limit exceeded',
    );
  } finally {
    await peer.close();
  }
});

test.each([
  'limit-subscribe',
  'prefix-subscribe',
  'limit-ping',
  'prefix-ping',
  'tiny-messages',
  'fragmented-limit',
  'default-limit',
])('WS %s retains packet capacity independently of message boundaries', async (mode) => {
  const peer = await startWebSocketPacketPeer(mode);
  try {
    const client = await createWebSocketClient({
      ...peer,
      clientId: mode,
      maxPacketBytes: mode === 'default-limit' ? undefined : mode === 'fragmented-limit' ? 130 : 8,
      maxWebSocketMessageBytes: mode === 'tiny-messages' ? 1 : 8,
      timeoutMs: 200,
    }).connect();
    const reason = await (mode.includes('subscribe') ? client.subscribe('a') : client.ping()).catch((failure: unknown) => failure);
    expect(reason).toMatchObject({ name: 'RangeError', message: 'MQTT packet allocation limit exceeded' });
    await expect(client.publish('a', 'late')).rejects.toBe(reason);
  } finally {
    await peer.close();
  }
});

test.each(['exact', 'mqtt-split', 'ws-fragments'])('WS %s preserves compact mutable Buffer payloads', async (mode) => {
  const peer = await startWebSocketPacketPeer(mode);
  let payload: Buffer | undefined;
  try {
    const client = await createWebSocketClient({
      ...peer,
      clientId: mode,
      maxPacketBytes: 8,
      maxWebSocketMessageBytes: mode === 'mqtt-split' ? 1 : 8,
      onMessage(packet: unknown) {
        if (typeof packet === 'object' && packet !== null && 'payload' in packet && Buffer.isBuffer(packet.payload))
          payload = packet.payload;
      },
    }).connect();
    await client.publish('a', 'test');
    await client.ping();
    expect(Buffer.isBuffer(payload)).toBe(true);
    if (!payload) throw new Error('Expected payload');
    expect(payload.buffer.byteLength).toBeLessThanOrEqual(8);
    payload[0] = 72;
    expect(payload.toString()).toBe('Hi');
    await client.disconnect();
  } finally {
    await peer.close();
  }
});

test('WS remote EOF rejects a partial CONNACK', async () => {
  const peer = await startWebSocketPacketPeer('eof-connect');
  try {
    await expect(createWebSocketClient({ ...peer, clientId: 'eof-connect' }).connect()).rejects.toThrow(
      'Truncated MQTT packet at end of input',
    );
  } finally {
    await peer.close();
  }
});

test.each(['eof-ping', 'eof-body'])('WS %s reports truncated MQTT input', async (mode) => {
  const peer = await startWebSocketPacketPeer(mode);
  try {
    const client = await createWebSocketClient({ ...peer, clientId: mode }).connect();
    await expect(client.ping()).rejects.toThrow('Truncated MQTT packet at end of input');
  } finally {
    await peer.close();
  }
});

test('WS refusal keeps its reason ahead of partial input at close', async () => {
  const peer = await startWebSocketPacketPeer('refusal-partial');
  try {
    await expect(createWebSocketClient({ ...peer, clientId: 'refused' }).connect()).rejects.toMatchObject({ code: 135 });
  } finally {
    await peer.close();
  }
});

test('WS callback abort stops the coalesced publication suffix', async () => {
  const peer = await startWebSocketPacketPeer('callback-abort');
  const allocations = vi.spyOn(Buffer, 'allocUnsafeSlow');
  const controller = new AbortController();
  const reason = new Error('publication abort');
  const onMessage = vi.fn<() => void>(() => {
    controller.abort(reason);
  });
  try {
    const client = await createWebSocketClient({
      ...peer,
      clientId: 'callback-abort',
      signal: controller.signal,
      onMessage,
    }).connect();
    allocations.mockClear();
    await expect(client.ping()).rejects.toBe(reason);
    await expect(client.publish('a', 'late')).rejects.toBe(reason);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(allocations).toHaveBeenCalledTimes(1);
  } finally {
    allocations.mockRestore();
    await peer.close();
  }
});

test('WS timeout keeps its cause with partial input and releases cancellation', async () => {
  const peer = await startWebSocketPacketPeer('partial-timeout');
  const controller = new AbortController();
  try {
    const client = await createWebSocketClient({
      ...peer,
      clientId: 'timeout',
      signal: controller.signal,
      timeoutMs: 100,
    }).connect();
    const reason = await client.ping().catch((failure: unknown) => failure);
    expect(reason).toMatchObject({ message: 'MQTT operation timed out' });
    await expect(client.publish('a', 'late')).rejects.toBe(reason);
    await vi.waitFor(() => {
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    });
  } finally {
    await peer.close();
  }
});

test('WS delivers a publication prefix before rejecting a declared excess', async () => {
  const peer = await startWebSocketPacketPeer('publication-prefix-limit');
  const onMessage = vi.fn<(packet: unknown) => void>();
  try {
    const client = await createWebSocketClient({ ...peer, clientId: 'prefix', maxPacketBytes: 8, onMessage }).connect();
    await expect(client.ping()).rejects.toThrow('MQTT packet allocation limit exceeded');
    expect(onMessage).toHaveBeenCalledTimes(1);
  } finally {
    await peer.close();
  }
});

test('WS abort owns partial input without later truncation', async () => {
  const peer = await startWebSocketPacketPeer('partial-active');
  const controller = new AbortController();
  try {
    const client = await createWebSocketClient({ ...peer, clientId: 'abort', signal: controller.signal }).connect();
    await client.ping();
    const reason = new Error('active abort');
    controller.abort(reason);
    await expect(client.publish('a', 'late')).rejects.toBe(reason);
    await vi.waitFor(() => {
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    });
  } finally {
    await peer.close();
  }
});

test('WS disconnect owns partial input without later truncation', async () => {
  const peer = await startWebSocketPacketPeer('partial-active');
  const controller = new AbortController();
  const completion = vi.spyOn(NodePacketDecoder.prototype, 'finish');
  try {
    const client = await createWebSocketClient({ ...peer, clientId: 'disconnect', signal: controller.signal }).connect();
    await client.ping();
    await expect(client.disconnect()).resolves.toBeUndefined();
    expect(completion).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    });
  } finally {
    completion.mockRestore();
    await peer.close();
  }
});

test('WS packet rejection terminates the native client before peer cleanup', async () => {
  const peer = await startWebSocketPacketPeer('limit-ping');
  const emissions = vi.spyOn(WebSocket.prototype, 'emit');
  let owner: WebSocket | undefined;
  try {
    const client = await createWebSocketClient({ ...peer, clientId: 'terminate', maxPacketBytes: 8 }).connect();
    const connected: unknown = emissions.mock.contexts.find(
      (candidate: unknown) => candidate instanceof WebSocket && candidate.url === new URL(peer.url).href,
    );
    if (!(connected instanceof WebSocket)) throw new Error('Expected connected WebSocket');
    owner = connected;
    await expect(client.ping()).rejects.toThrow('MQTT packet allocation limit exceeded');
    await vi.waitFor(() => {
      expect(connected.readyState).toBe(WebSocket.CLOSED);
    });
  } finally {
    emissions.mockRestore();
    owner?.terminate();
    await peer.close();
  }
});

test('WS payload transfer cannot detach a coalesced PINGRESP', async () => {
  const peer = await startWebSocketPacketPeer('transfer-prefix');
  let transferred: Uint8Array | undefined;
  try {
    const client = await createWebSocketClient({
      ...peer,
      clientId: 'transfer',
      maxPacketBytes: 8,
      onMessage(packet: unknown) {
        if (typeof packet !== 'object' || packet === null || !('payload' in packet) || !Buffer.isBuffer(packet.payload))
          throw new Error('Expected Buffer');
        const buffer = packet.payload.buffer;
        if (!(buffer instanceof ArrayBuffer)) throw new Error('Expected ordinary backing buffer');
        transferred = structuredClone(new Uint8Array(buffer, packet.payload.byteOffset, packet.payload.byteLength), {
          transfer: [buffer],
        });
      },
    }).connect();
    await expect(client.ping()).resolves.toBeUndefined();
    expect(transferred).toEqual(Uint8Array.of(104, 105));
    await client.disconnect();
  } finally {
    await peer.close();
  }
});

test('WS native message limit keeps its reason ahead of partial MQTT EOF', async () => {
  const peer = await startWebSocketPacketPeer('native-limit-partial');
  try {
    const client = await createWebSocketClient({ ...peer, clientId: 'native-limit', maxWebSocketMessageBytes: 8 }).connect();
    const reason = await client.ping().catch((failure: unknown) => failure);
    expect(reason).toMatchObject({ code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' });
    await expect(client.publish('a', 'late')).rejects.toBe(reason);
  } finally {
    await peer.close();
  }
});

test('WS text rejection keeps its reason ahead of remote close', async () => {
  const peer = await startWebSocketPacketPeer('text');
  try {
    const client = await createWebSocketClient({ ...peer, clientId: 'text' }).connect();
    await expect(client.ping()).rejects.toThrow('MQTT WebSocket requires binary messages');
  } finally {
    await peer.close();
  }
});
