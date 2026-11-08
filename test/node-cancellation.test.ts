import { getEventListeners } from 'node:events';
import { expect, test } from 'vitest';
import { createTcpClient, createWebSocketClient } from '../src/index.js';
import { startCancellationPeer } from './experiments/node-cancellation-peer.js';

test.each(['tcp', 'websocket'] as const)(
  '%s active abort rejects pending and immediate later work with the exact reason',
  async (kind) => {
    const peer = await startCancellationPeer(kind);
    const controller = new AbortController();
    const options = { ...peer, clientId: 'active-abort', signal: controller.signal, timeoutMs: 1000 };
    try {
      const client = await (kind === 'tcp' ? createTcpClient(options) : createWebSocketClient(options)).connect();
      const pending = client.ping().catch((reason: unknown) => reason);
      await peer.pingSeen;
      const reason = new Error('cancel active connection');
      controller.abort(reason);
      const later = client.publish('late', 'must not be sent').catch((error: unknown) => error);
      const laterSubscribe = client.subscribe('late').catch((error: unknown) => error);
      const laterPing = client.ping().catch((error: unknown) => error);
      await expect(later).resolves.toBe(reason);
      await expect(laterSubscribe).resolves.toBe(reason);
      await expect(laterPing).resolves.toBe(reason);
      await expect(pending).resolves.toBe(reason);
      await peer.peerClosed;
      expect(peer.commands).toEqual(['connect', 'pingreq']);
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
      controller.abort(new Error('later cancellation'));
      await expect(client.ping()).rejects.toBe(reason);
    } finally {
      await peer.close();
    }
  },
);

test.each(['tcp', 'websocket'] as const)('%s retains active cancellation until normal disconnect cleans it up', async (kind) => {
  const peer = await startCancellationPeer(kind);
  const controller = new AbortController();
  const options = { ...peer, clientId: 'normal-close', signal: controller.signal };
  try {
    const client = await (kind === 'tcp' ? createTcpClient(options) : createWebSocketClient(options)).connect();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    await client.disconnect();
    await peer.peerClosed;
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  } finally {
    await peer.close();
  }
});

test.each(['tcp', 'websocket'] as const)('%s normalizes a primitive cancellation reason once', async (kind) => {
  const peer = await startCancellationPeer(kind);
  const controller = new AbortController();
  const options = { ...peer, clientId: 'primitive-abort', signal: controller.signal };
  try {
    const client = await (kind === 'tcp' ? createTcpClient(options) : createWebSocketClient(options)).connect();
    controller.abort('stop');
    const failure = await client.publish('late', 'not sent').catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ name: 'AbortError' });
    await expect(client.subscribe('late')).rejects.toBe(failure);
    await peer.peerClosed;
    expect(peer.commands).toEqual(['connect']);
  } finally {
    await peer.close();
  }
});

test.each(['tcp', 'websocket'] as const)('%s remote close releases cancellation and keeps the original failure', async (kind) => {
  const peer = await startCancellationPeer(kind);
  const controller = new AbortController();
  const options = { ...peer, clientId: 'remote-close', signal: controller.signal };
  try {
    const client = await (kind === 'tcp' ? createTcpClient(options) : createWebSocketClient(options)).connect();
    const pending = client.ping().catch((reason: unknown) => reason);
    await peer.pingSeen;
    peer.drop();
    const failure = await pending;
    expect(failure).toBeInstanceOf(Error);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    controller.abort(new Error('too late'));
    await expect(client.publish('late', 'not sent')).rejects.toBe(failure);
  } finally {
    await peer.close();
  }
});

test.each(['tcp', 'websocket'] as const)('%s rejects an already aborted signal without opening', async (kind) => {
  const peer = await startCancellationPeer(kind);
  const controller = new AbortController();
  const reason = new Error('do not open');
  controller.abort(reason);
  const options = { ...peer, clientId: 'never-open', signal: controller.signal };
  try {
    const factory = kind === 'tcp' ? createTcpClient(options) : createWebSocketClient(options);
    await expect(factory.connect()).rejects.toBe(reason);
    expect(peer.commands).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  } finally {
    await peer.close();
  }
});
