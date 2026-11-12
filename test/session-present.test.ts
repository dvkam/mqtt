import { getEventListeners } from 'node:events';
import { expect, test, vi } from 'vitest';
import { connectPortable, type PacketTransport } from '../src/portable.js';
import { PacketDecoder, encodePacket } from '../src/codec.js';
import { createTcpClient, createWebSocketClient } from '../src/index.js';
import { createBrowserClient } from '../src/browser.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

function decodedPeer() {
  let receive: Parameters<PacketTransport['listen']>[0] | undefined;
  let closed: Parameters<PacketTransport['listen']>[1] | undefined;
  const close = vi.fn<(force?: boolean) => Promise<void>>(async () => {
    await Promise.resolve();
  });
  const connects: { clean: boolean | undefined; clientId: string | undefined }[] = [];
  const commands: string[] = [];
  const transport: PacketTransport = {
    async send(packet: Readonly<{ cmd: string; clean?: boolean; clientId?: string }>) {
      commands.push(packet.cmd);
      if (packet.cmd === 'connect') connects.push({ clean: packet.clean, clientId: packet.clientId });
      await Promise.resolve();
    },
    listen(onPacket, onClose) {
      receive = onPacket;
      closed = onClose;
      return () => {};
    },
    close,
  };
  return { transport, connects, commands, close, receive: () => receive, closed: () => closed };
}

test.each([0, 0x87])('rejects decoded Session Present with reason %i before acceptance', async (reasonCode) => {
  const peer = decodedPeer();
  const onQosOneMessage = vi.fn<() => Promise<void>>(async () => {
    await Promise.resolve();
  });
  const onMessage = vi.fn<() => void>();
  const ended = vi.fn<(notice: unknown) => void>();
  const opening = connectPortable(peer.transport, {
    clientId: 'clean-start',
    onMessage,
    onQosOneMessage,
    onSessionEnd: ended,
  }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'connack', sessionPresent: true, reasonCode });
  peer.receive()?.({ cmd: 'publish', qos: 1, topic: 'a', payload: Buffer.alloc(0), messageId: 1, dup: false, retain: false });
  peer.receive()?.({ cmd: 'publish', qos: 0, topic: 'a', payload: Buffer.alloc(0), dup: false, retain: false });
  peer.closed()?.(new Error('later close'));
  const failure = await opening;
  expect(failure).toMatchObject({ message: 'Unexpected MQTT Session Present', code: 0x82 });
  expect(peer.connects).toEqual([{ clean: true, clientId: 'clean-start' }]);
  expect(peer.commands).toEqual(['connect']);
  expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
  expect(onMessage).not.toHaveBeenCalled();
  expect(onQosOneMessage).not.toHaveBeenCalled();
  expect(ended).toHaveBeenCalledTimes(1);
  const notice = ended.mock.calls[0]?.[0];
  if (typeof notice !== 'object' || notice === null || !('error' in notice)) throw new Error('Expected session error notice');
  expect(notice.error).toBe(failure);
});

test('Session Present failure owns the result before a coalesced later refusal', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: 'clean-start' }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'connack', sessionPresent: true, reasonCode: 0 });
  peer.receive()?.({ cmd: 'connack', sessionPresent: false, reasonCode: 0x87 });
  expect(await opening).toMatchObject({ message: 'Unexpected MQTT Session Present', code: 0x82 });
});

test('an earlier refusal owns the result before Session Present violation', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: 'clean-start' }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'connack', sessionPresent: false, reasonCode: 0x87 });
  peer.receive()?.({ cmd: 'connack', sessionPresent: true, reasonCode: 0 });
  expect(await opening).toMatchObject({ message: 'MQTT acknowledgment refused', code: 0x87 });
});

test('Session Present false permits a clean session without a persistence option', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: 'clean-start' });
  peer.receive()?.({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
  const client = await opening;
  expect(peer.connects).toEqual([{ clean: true, clientId: 'clean-start' }]);
  await client.disconnect();
});

test('a second CONNACK claiming Session Present retires accepted opening before queued QoS 1 delivery', async () => {
  const peer = decodedPeer();
  const onQosOneMessage = vi.fn<() => Promise<void>>(async () => {
    await Promise.resolve();
  });
  const opening = connectPortable(peer.transport, { clientId: 'clean-start', onQosOneMessage }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
  peer.receive()?.({ cmd: 'publish', qos: 1, topic: 'a', payload: Buffer.alloc(0), messageId: 1, dup: false, retain: false });
  peer.receive()?.({ cmd: 'connack', sessionPresent: true, reasonCode: 0 });
  expect(await opening).toMatchObject({ message: 'Duplicate MQTT CONNACK', code: 0x82 });
  expect(onQosOneMessage).not.toHaveBeenCalled();
  expect(peer.commands).toEqual(['connect', 'disconnect']);
  expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
});

test('standalone codec preserves Session Present for callers that can request resume', () => {
  const bytes = Uint8Array.of(0x20, 3, 1, 0, 0);
  const packet = { cmd: 'connack' as const, sessionPresent: true, reasonCode: 0 };
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new PacketDecoder();
    expect([...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))]).toEqual([packet]);
  }
  expect(encodePacket(packet)).toEqual(bytes);
  expect(encodePacket({ cmd: 'connect', clientId: 'resume', cleanStart: false })[9]).toBe(0);
});

const adapters = ['tcp', 'node-websocket', 'browser'] as const;
test.each(adapters.flatMap((adapter) => [false, true].map((accepted) => ({ adapter, accepted }))))(
  '$adapter rejects Session Present with earlier acceptance=$accepted before application delivery and closes',
  async ({ adapter, accepted }: Readonly<{ adapter: (typeof adapters)[number]; accepted: boolean }>) => {
    const bytes = [...(accepted ? [0x20, 3, 0, 0, 0] : []), 0x20, 3, 1, 0, 0, 0x30, 5, 0, 1, 0x61, 0, 0x78];
    const peer =
      adapter === 'tcp' ? await startTcpPacketPeer('fixed-connect', bytes) : await startWebSocketPacketPeer('fixed-connect', bytes);
    const controller = new AbortController();
    const onMessage = vi.fn<() => void>();
    const ended = vi.fn<(notice: unknown) => void>();
    try {
      const options = { clientId: 'clean-start', timeoutMs: 1000, signal: controller.signal, onMessage, onSessionEnd: ended };
      const factory =
        'host' in peer
          ? createTcpClient({ ...peer, ...options })
          : adapter === 'browser'
            ? createBrowserClient({ ...peer, ...options })
            : createWebSocketClient({ ...peer, ...options });
      const opening = factory.connect();
      expect(factory.connect()).toBe(opening);
      const failure = await opening.catch((reason: unknown) => reason);
      expect(failure).toMatchObject({
        message: accepted ? 'Duplicate MQTT CONNACK' : 'Unexpected MQTT Session Present',
        code: 0x82,
      });
      await expect(factory.connect()).rejects.toBe(failure);
      await expect.poll(peer.connections).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(peer.commands[0]).toBe('connect');
      expect(peer.commands.every((command) => command === 'connect' || command === 'disconnect')).toBe(true);
      expect(onMessage).not.toHaveBeenCalled();
      expect(ended).toHaveBeenCalledTimes(1);
      const notice = ended.mock.calls[0]?.[0];
      if (typeof notice !== 'object' || notice === null || !('error' in notice)) throw new Error('Expected session error notice');
      expect(notice.error).toBe(failure);
    } finally {
      controller.abort();
      await peer.close();
    }
  },
);

test.each(adapters)('%s preserves a valid refusal with Session Present false', async (adapter) => {
  const bytes = [0x20, 3, 0, 0x87, 0, 0x20, 3, 1, 0, 0];
  const peer =
    adapter === 'tcp' ? await startTcpPacketPeer('fixed-connect', bytes) : await startWebSocketPacketPeer('fixed-connect', bytes);
  try {
    const options = { clientId: 'clean-start', timeoutMs: 1000 };
    const factory =
      'host' in peer
        ? createTcpClient({ ...peer, ...options })
        : adapter === 'browser'
          ? createBrowserClient({ ...peer, ...options })
          : createWebSocketClient({ ...peer, ...options });
    const failure = await factory.connect().catch((reason: unknown) => reason);
    expect(failure).toMatchObject({ message: 'MQTT acknowledgment refused', code: 0x87 });
    await expect(factory.connect()).rejects.toBe(failure);
    await expect.poll(peer.connections).toBe(0);
  } finally {
    await peer.close();
  }
});

test.each(adapters)('%s retires active Session Present before ping and publication suffixes', async (adapter) => {
  const bytes = [0x20, 3, 1, 0, 0, 0xd0, 0, 0x30, 5, 0, 1, 0x61, 0, 0x78];
  const peer =
    adapter === 'tcp' ? await startTcpPacketPeer('fixed-ping', bytes) : await startWebSocketPacketPeer('fixed-ping', bytes);
  const controller = new AbortController();
  const onMessage = vi.fn<() => void>();
  const ended = vi.fn<(notice: unknown) => void>();
  try {
    const options = { clientId: 'clean-start', timeoutMs: 1000, signal: controller.signal, onMessage, onSessionEnd: ended };
    const factory =
      'host' in peer
        ? createTcpClient({ ...peer, ...options })
        : adapter === 'browser'
          ? createBrowserClient({ ...peer, ...options })
          : createWebSocketClient({ ...peer, ...options });
    const client = await factory.connect();
    const failure = await client.ping().catch((reason: unknown) => reason);
    expect(failure).toMatchObject({ message: 'Duplicate MQTT CONNACK', code: 0x82 });
    await expect(client.ping()).rejects.toBe(failure);
    await expect.poll(peer.connections).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(onMessage).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledTimes(1);
    const notice = ended.mock.calls[0]?.[0];
    if (typeof notice !== 'object' || notice === null || !('error' in notice)) throw new Error('Expected session error notice');
    expect(notice.error).toBe(failure);
  } finally {
    controller.abort();
    await peer.close();
  }
});
