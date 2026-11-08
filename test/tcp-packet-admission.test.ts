import { expect, test, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { createTcpClient } from '../src/index.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';

test.each([0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 268_435_461])(
  'TCP rejects packet capacity %s before host access',
  async (maxPacketBytes) => {
    let accesses = 0;
    await expect(
      createTcpClient({
        get host(): string {
          accesses++;
          throw new Error('Unexpected connection construction');
        },
        clientId: 'invalid-packet-cap',
        maxPacketBytes,
      }).connect(),
    ).rejects.toBeInstanceOf(RangeError);
    expect(accesses).toBe(0);
  },
);

test.each(['limit-connect', 'prefix-connect'])('TCP %s rejects pending opening before any body arrives', async (mode) => {
  const peer = await startTcpPacketPeer(mode);
  try {
    await expect(createTcpClient({ ...peer, clientId: mode, maxPacketBytes: 8, timeoutMs: 1000 }).connect()).rejects.toMatchObject({
      name: 'RangeError',
      message: 'MQTT packet allocation limit exceeded',
    });
  } finally {
    await peer.close();
  }
});

test.each(['limit-subscribe', 'prefix-subscribe', 'limit-ping', 'prefix-ping', 'fragmented-limit', 'default-limit'])(
  'TCP %s retains the packet-capacity failure',
  async (mode) => {
    const peer = await startTcpPacketPeer(mode);
    const onMessage = vi.fn<(packet: unknown) => void>();
    try {
      const client = await createTcpClient({
        ...peer,
        clientId: mode,
        maxPacketBytes: mode === 'default-limit' ? undefined : mode === 'fragmented-limit' ? 130 : 8,
        timeoutMs: 1000,
        onMessage,
      }).connect();
      const failure = await (mode.includes('subscribe') ? client.subscribe('a') : client.ping()).catch((reason: unknown) => reason);
      expect(failure).toMatchObject({ name: 'RangeError', message: 'MQTT packet allocation limit exceeded' });
      await expect(client.publish('a', 'late')).rejects.toBe(failure);
      await expect(client.subscribe('a')).rejects.toBe(failure);
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      await peer.close();
    }
  },
);

test('TCP accepts exact-limit packets with compact mutable Buffer payloads', async () => {
  const peer = await startTcpPacketPeer('exact');
  let payload: Buffer | undefined;
  try {
    const client = await createTcpClient({
      ...peer,
      clientId: 'exact',
      maxPacketBytes: 8,
      onMessage(packet: unknown) {
        if (typeof packet === 'object' && packet !== null && 'payload' in packet && Buffer.isBuffer(packet.payload))
          payload = packet.payload;
      },
    }).connect();
    await client.publish('a', 'test');
    await client.ping();
    expect(payload).toBeInstanceOf(Buffer);
    if (!payload) throw new Error('Expected echo payload');
    expect(payload.buffer.byteLength).toBeLessThanOrEqual(8);
    payload[0] = 72;
    expect(payload.toString()).toBe('Hi');
    await client.disconnect();
  } finally {
    await peer.close();
  }
});

test('TCP remote EOF rejects a partial CONNACK', async () => {
  const peer = await startTcpPacketPeer('eof-connect');
  try {
    await expect(createTcpClient({ ...peer, clientId: 'partial-opening' }).connect()).rejects.toThrow(
      'Truncated MQTT packet at end of input',
    );
  } finally {
    await peer.close();
  }
});

test.each(['eof-ping', 'eof-body'])('TCP %s reports truncation to the pending operation', async (mode) => {
  const peer = await startTcpPacketPeer(mode);
  try {
    const client = await createTcpClient({ ...peer, clientId: mode }).connect();
    const failure = await client.ping().catch((reason: unknown) => reason);
    expect(failure).toMatchObject({ message: 'Truncated MQTT packet at end of input' });
    await expect(client.publish('a', 'late')).rejects.toBe(failure);
  } finally {
    await peer.close();
  }
});

test('TCP refusal retains its reason code ahead of trailing partial input', async () => {
  const peer = await startTcpPacketPeer('refusal-partial');
  try {
    await expect(createTcpClient({ ...peer, clientId: 'refusal' }).connect()).rejects.toMatchObject({ code: 135 });
  } finally {
    await peer.close();
  }
});

test('TCP abort retains its reason ahead of partial-input EOF', async () => {
  const peer = await startTcpPacketPeer('partial-active');
  const controller = new AbortController();
  try {
    const client = await createTcpClient({ ...peer, clientId: 'abort-partial', signal: controller.signal }).connect();
    await client.ping();
    const reason = new Error('cancel partial input');
    controller.abort(reason);
    await expect(client.publish('a', 'late')).rejects.toBe(reason);
    expect(peer.commands).not.toContain('publish');
  } finally {
    await peer.close();
  }
});

test('TCP disconnect completes with partial input without reporting truncation', async () => {
  const peer = await startTcpPacketPeer('partial-active');
  try {
    const client = await createTcpClient({ ...peer, clientId: 'disconnect-partial' }).connect();
    await client.ping();
    await client.disconnect();
    await expect(client.publish('a', 'late')).rejects.toThrow('Client is closing');
    expect(peer.commands).not.toContain('publish');
  } finally {
    await peer.close();
  }
});

test('TCP callback abort stops a coalesced publication suffix and pending ping', async () => {
  const peer = await startTcpPacketPeer('callback-abort');
  const controller = new AbortController();
  const reason = new Error('stop after first publication');
  const onMessage = vi.fn<(packet: unknown) => void>(() => {
    controller.abort(reason);
  });
  try {
    const client = await createTcpClient({ ...peer, clientId: 'callback-abort', signal: controller.signal, onMessage }).connect();
    await expect(client.ping()).rejects.toBe(reason);
    await expect(client.publish('a', 'late')).rejects.toBe(reason);
    expect(onMessage).toHaveBeenCalledTimes(1);
  } finally {
    await peer.close();
  }
});

test('TCP readable EOF rejects a blocked write before native close can drain it', async () => {
  const peer = await startTcpPacketPeer('blocked-write-eof');
  try {
    const client = await createTcpClient({ ...peer, clientId: 'blocked-write-eof', timeoutMs: 1000 }).connect();
    await expect(client.publish('a', 'x'.repeat(8 * 1024 * 1024))).rejects.toThrow('Truncated MQTT packet at end of input');
    expect(peer.commands).toEqual(['connect']);
  } finally {
    await peer.close();
  }
});

test('TCP delivers a complete publication prefix before rejecting an oversized suffix', async () => {
  const peer = await startTcpPacketPeer('publish-prefix-limit');
  const onMessage = vi.fn<(packet: unknown) => void>();
  try {
    const client = await createTcpClient({ ...peer, clientId: 'publication-prefix', maxPacketBytes: 8, onMessage }).connect();
    const reason = await client.ping().catch((failure: unknown) => failure);
    expect(reason).toMatchObject({ message: 'MQTT packet allocation limit exceeded' });
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cmd: 'publish', payload: Buffer.from('hi') }));
    await expect(client.publish('a', 'late')).rejects.toBe(reason);
  } finally {
    await peer.close();
  }
});

test('TCP ping timeout retains its reason with partial input and releases cancellation on forced close', async () => {
  const peer = await startTcpPacketPeer('partial-timeout');
  const controller = new AbortController();
  try {
    const client = await createTcpClient({
      ...peer,
      clientId: 'partial-timeout',
      signal: controller.signal,
      timeoutMs: 1000,
    }).connect();
    const reason = await client.ping().catch((failure: unknown) => failure);
    expect(reason).toMatchObject({ message: 'MQTT operation timed out' });
    await expect(client.publish('a', 'late')).rejects.toBe(reason);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  } finally {
    await peer.close();
  }
});

test('TCP payload transfer cannot detach the coalesced protocol input', async () => {
  const peer = await startTcpPacketPeer('transfer-prefix-ping');
  let transferred: Uint8Array | undefined;
  try {
    const client = await createTcpClient({
      ...peer,
      clientId: 'transfer-payload',
      maxPacketBytes: 8,
      onMessage(packet: unknown) {
        if (typeof packet !== 'object' || packet === null || !('payload' in packet) || !Buffer.isBuffer(packet.payload))
          throw new Error('Expected Buffer payload');
        const buffer = packet.payload.buffer;
        if (!(buffer instanceof ArrayBuffer)) throw new Error('Expected ordinary backing buffer');
        const view = new Uint8Array(buffer, packet.payload.byteOffset, packet.payload.byteLength);
        transferred = structuredClone(view, { transfer: [buffer] });
      },
    }).connect();
    await expect(client.ping()).resolves.toBeUndefined();
    expect(transferred).toEqual(Uint8Array.of(104, 105));
    await client.disconnect();
  } finally {
    await peer.close();
  }
});
