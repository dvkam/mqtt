import { Socket } from 'node:net';
import { expect, test, vi } from 'vitest';
import { createTcpClient } from '../src/tcpClient.js';
import { startCancellationPeer } from './experiments/node-cancellation-peer.js';

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
