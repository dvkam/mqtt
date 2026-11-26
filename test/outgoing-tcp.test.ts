import { Socket } from 'node:net';
import { expect, test, vi } from 'vitest';
import { createTcpClient } from '../src/tcpClient.js';
import { startCancellationPeer } from './experiments/node-cancellation-peer.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';

test('a held TCP write cannot admit another publication before timeout', async () => {
  const peer = await startCancellationPeer('tcp');
  const controller = new AbortController();
  const writes = vi.spyOn(Socket.prototype, 'write');
  let owner: Socket | undefined;
  let restore: (() => void) | undefined;
  try {
    const client = await createTcpClient({
      ...peer,
      clientId: 'bounded-tcp',
      signal: controller.signal,
      maxPendingPublishes: 1,
      maxPendingPublishBytes: 32,
    }).connect();
    const connected: unknown = writes.mock.contexts.find(
      (candidate: unknown) => candidate instanceof Socket && candidate.remotePort === peer.port,
    );
    writes.mockRestore();
    if (!(connected instanceof Socket)) throw new Error('Expected client socket');
    owner = connected;
    const held = vi.spyOn(owner, '_write').mockImplementation(() => {});
    restore = () => {
      held.mockRestore();
    };
    const pending = client.publish('a', 'held').catch((reason: unknown) => reason);
    const queued = owner.writableLength;
    expect(queued).toBeGreaterThan(0);
    const excess = client.publish('a', 'excess').catch((reason: unknown) => reason);
    expect(owner.writableLength).toBe(queued);
    await expect(excess).resolves.toMatchObject({ message: 'MQTT publication capacity exceeded' });
    const reason = new Error('stop held write');
    controller.abort(reason);
    await expect(pending).resolves.toBe(reason);
    await peer.peerClosed;
    expect(held).toHaveBeenCalledTimes(1);
    expect(peer.commands).toEqual(['connect']);
  } finally {
    writes.mockRestore();
    restore?.();
    owner?.destroy();
    await peer.close();
  }
});

test('submits the first TCP packet immediately and preserves call order in a native batch', async () => {
  const peer = await startTcpPacketPeer('ordered');
  const writes = vi.spyOn(Socket.prototype, 'write');
  let socket: Socket | undefined;
  try {
    const client = await createTcpClient({ host: peer.host, port: peer.port, clientId: 'wire-order' }).connect();
    const connected: unknown = writes.mock.contexts.find(
      (candidate: unknown) => candidate instanceof Socket && candidate.remotePort === peer.port,
    );
    writes.mockRestore();
    if (!(connected instanceof Socket)) throw new Error('Expected connected client socket');
    socket = connected;
    const single = vi.spyOn(socket, '_write');
    const batch = vi.spyOn(socket, '_writev');
    const first = client.publish('a', 'first');
    expect(single).toHaveBeenCalledTimes(1);
    const rest = [client.subscribe('a'), client.publish('a', 'second'), client.ping()];
    expect(socket.writableLength).toBeGreaterThan(0);
    await Promise.all([first, ...rest]);
    await client.disconnect();
    expect(batch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(peer.commands).toEqual(['connect', 'publish', 'subscribe', 'publish', 'pingreq', 'disconnect']);
    });
  } finally {
    writes.mockRestore();
    socket?.destroy();
    await peer.close();
  }
});

test('aborting before the TCP batch flush rejects each queued write with the caller error', async () => {
  const peer = await startCancellationPeer('tcp');
  const controller = new AbortController();
  const writes = vi.spyOn(Socket.prototype, 'write');
  let socket: Socket | undefined;
  try {
    const client = await createTcpClient({ ...peer, clientId: 'abort-native-batch', signal: controller.signal }).connect();
    const connected: unknown = writes.mock.contexts.find(
      (candidate: unknown) => candidate instanceof Socket && candidate.remotePort === peer.port,
    );
    writes.mockRestore();
    if (!(connected instanceof Socket)) throw new Error('Expected connected client socket');
    socket = connected;
    const batch = vi.spyOn(socket, '_writev');
    const operations = ['first', 'second', 'third'].map(async (payload) =>
      client.publish('a', payload).catch((reason: unknown) => reason),
    );
    expect(socket.writableLength).toBeGreaterThan(0);
    const error = new Error('aborted before native batch flush');
    controller.abort(error);
    for (const outcome of await Promise.all(operations)) expect(outcome).toBe(error);
    await peer.peerClosed;
    expect(batch).not.toHaveBeenCalled();
  } finally {
    writes.mockRestore();
    socket?.destroy();
    await peer.close();
  }
});

test('flushes a corked TCP tail before refusing a control write at the native budget', async () => {
  const peer = await startTcpPacketPeer('ordered');
  try {
    const client = await createTcpClient({
      host: peer.host,
      port: peer.port,
      clientId: 'tcp-batch-budget',
      maxBufferedBytes: 40,
      reservedControlBytes: 0,
    }).connect();
    await Promise.all([client.publish('a', '.'.repeat(34)), client.publish('a', '.'.repeat(34)), client.ping()]);
    await client.disconnect();
    await vi.waitFor(() => {
      expect(peer.commands).toEqual(['connect', 'publish', 'publish', 'pingreq', 'disconnect']);
    });
  } finally {
    await peer.close();
  }
});
