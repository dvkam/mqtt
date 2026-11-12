import { getEventListeners } from 'node:events';
import { expect, test, vi } from 'vitest';
import { connectPortable, type PacketTransport } from '../src/portable.js';
import { PacketDecoder } from '../src/codec.js';
import { createTcpClient, createWebSocketClient } from '../src/index.js';
import { createBrowserClient } from '../src/browser.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

function decodedPeer(earlyReplies = 0, holdConnect = false) {
  let receive: Parameters<PacketTransport['listen']>[0] | undefined;
  let closed: Parameters<PacketTransport['listen']>[1] | undefined;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands: string[] = [];
  const close = vi.fn<(force?: boolean) => Promise<void>>(async () => {
    await Promise.resolve();
  });
  const transport: PacketTransport = {
    async send(packet: Readonly<{ cmd: string }>) {
      commands.push(packet.cmd);
      if (packet.cmd === 'connect' && holdConnect) await held;
      else await Promise.resolve();
    },
    listen(onPacket, onClose) {
      receive = onPacket;
      closed = onClose;
      for (let index = 0; index < earlyReplies; index++) onPacket({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
      return () => {};
    },
    close,
  };
  return {
    transport,
    commands,
    close,
    release: () => {
      release();
    },
    receive: () => receive,
    closed: () => closed,
  };
}

test.each([0, 0x87])('a decoded second CONNACK with reason %i cannot settle opening again', async (reasonCode) => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: 'duplicate' }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
  peer.receive()?.({ cmd: 'connack', sessionPresent: false, reasonCode });
  peer.closed()?.(new Error('later close'));
  expect(await opening).toMatchObject({ message: 'Duplicate MQTT CONNACK', code: 0x82 });
  expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
});

test('replaying a mutable CONNACK object with changed capabilities is still a duplicate', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: 'duplicate' }).catch((reason: unknown) => reason);
  const packet = { cmd: 'connack' as const, sessionPresent: false, reasonCode: 0, properties: { receiveMaximum: 5 } };
  peer.receive()?.(packet);
  packet.properties.receiveMaximum = 1;
  peer.receive()?.(packet);
  expect(await opening).toMatchObject({ message: 'Duplicate MQTT CONNACK', code: 0x82 });
});

test('records receipt before a custom metadata getter can reenter delivery', async () => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: 'reentrant-duplicate' }).catch((reason: unknown) => reason);
  let reentered = false;
  peer.receive()?.({
    cmd: 'connack',
    reasonCode: 0,
    get sessionPresent() {
      if (!reentered) {
        reentered = true;
        peer.receive()?.({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
      }
      return false;
    },
  });
  expect(await opening).toMatchObject({ message: 'Duplicate MQTT CONNACK', code: 0x82 });
  expect(reentered).toBe(true);
});

test.each([1, 2])('counts %i registration-time CONNACK replies before an exchange exists', async (earlyReplies) => {
  const peer = decodedPeer(earlyReplies);
  const opening = connectPortable(peer.transport, { clientId: 'early-duplicate' }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
  expect(await opening).toMatchObject({ message: 'Duplicate MQTT CONNACK', code: 0x82 });
  expect(peer.commands).toEqual(earlyReplies === 1 ? ['connect'] : []);
  expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
});

test('a duplicate retires a held CONNECT and queued QoS 1 without waiting for send settlement', async () => {
  const peer = decodedPeer(0, true);
  const onQosOneMessage = vi.fn<() => Promise<void>>(async () => {
    await Promise.resolve();
  });
  try {
    const opening = connectPortable(peer.transport, { clientId: 'held-duplicate', timeoutMs: 1000, onQosOneMessage }).catch(
      (reason: unknown) => reason,
    );
    peer.receive()?.({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
    peer.receive()?.({
      cmd: 'publish',
      topic: 'queued',
      qos: 1,
      messageId: 1,
      dup: false,
      retain: false,
      payload: Buffer.alloc(0),
    });
    peer.receive()?.({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
    expect(await opening).toMatchObject({ message: 'Duplicate MQTT CONNACK', code: 0x82 });
    expect(onQosOneMessage).not.toHaveBeenCalled();
    expect(peer.commands).toEqual(['connect', 'disconnect']);
    expect(peer.close).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    peer.release();
  }
});

test.each([false, true])('an earlier terminal CONNACK keeps ownership, refusal=%s', async (refusal) => {
  const peer = decodedPeer();
  const opening = connectPortable(peer.transport, { clientId: 'first-error' }).catch((reason: unknown) => reason);
  peer.receive()?.({ cmd: 'connack', sessionPresent: !refusal, reasonCode: refusal ? 0x87 : 0 });
  peer.receive()?.({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
  expect(await opening).toMatchObject({
    code: refusal ? 0x87 : 0x82,
    message: refusal ? 'MQTT acknowledgment refused' : 'Unexpected MQTT Session Present',
  });
});

test('each independent client accepts its first CONNACK and ordinary packets do not consume it', async () => {
  for (let index = 0; index < 2; index++) {
    const peer = decodedPeer();
    const opening = connectPortable(peer.transport, { clientId: 'independent' });
    peer.receive()?.({ cmd: 'pingresp' });
    peer.receive()?.({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
    const client = await opening;
    await client.disconnect();
    expect(peer.commands).toEqual(['connect', 'disconnect']);
  }
});

test('standalone decoding remains stateless about repeated CONNACK at every split', () => {
  const bytes = Uint8Array.of(0x20, 3, 0, 0, 0, 0x20, 3, 0, 0, 0);
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new PacketDecoder();
    expect([...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))]).toEqual([
      { cmd: 'connack', sessionPresent: false, reasonCode: 0 },
      { cmd: 'connack', sessionPresent: false, reasonCode: 0 },
    ]);
  }
});

const adapters = ['tcp', 'node-websocket', 'browser'] as const;
test.each(adapters)('%s rejects coalesced duplicate CONNACK before opening handoff', async (adapter) => {
  const bytes = [0x20, 3, 0, 0, 0, 0x20, 3, 0, 0, 0, 0x30, 4, 0, 1, 0x73, 0];
  const peer =
    adapter === 'tcp' ? await startTcpPacketPeer('fixed-connect', bytes) : await startWebSocketPacketPeer('fixed-connect', bytes);
  const controller = new AbortController();
  const onMessage = vi.fn<() => void>();
  const ended = vi.fn<(notice: unknown) => void>();
  try {
    const options = { clientId: 'duplicate-wire', timeoutMs: 1000, signal: controller.signal, onMessage, onSessionEnd: ended };
    const factory =
      'host' in peer
        ? createTcpClient({ ...peer, ...options })
        : adapter === 'browser'
          ? createBrowserClient({ ...peer, ...options })
          : createWebSocketClient({ ...peer, ...options });
    const opening = factory.connect();
    expect(factory.connect()).toBe(opening);
    const failure = await opening.catch((reason: unknown) => reason);
    expect(failure).toMatchObject({ message: 'Duplicate MQTT CONNACK', code: 0x82 });
    await expect(factory.connect()).rejects.toBe(failure);
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

test.each([
  { adapter: 'tcp', fragmented: false },
  { adapter: 'node-websocket', fragmented: false },
  { adapter: 'browser', fragmented: false },
  { adapter: 'node-websocket', fragmented: true },
  { adapter: 'browser', fragmented: true },
] as const)(
  '$adapter preserves the prefix and rejects active duplicate CONNACK, fragmented=$fragmented',
  async ({ adapter, fragmented }: Readonly<{ adapter: (typeof adapters)[number]; fragmented: boolean }>) => {
    const bytes = [0x30, 4, 0, 1, 0x70, 0, 0x20, 3, 0, 0, 0, 0xd0, 0, 0x30, 4, 0, 1, 0x73, 0];
    const peer =
      adapter === 'tcp'
        ? await startTcpPacketPeer('fixed-ping', bytes)
        : await startWebSocketPacketPeer(fragmented ? 'split-fixed-ping' : 'fixed-ping', bytes);
    const controller = new AbortController();
    const topics: string[] = [];
    const ended = vi.fn<(notice: unknown) => void>();
    try {
      const options = {
        clientId: 'duplicate-active',
        timeoutMs: 1000,
        signal: controller.signal,
        onSessionEnd: ended,
        onMessage(packet: Readonly<{ topic: string }>) {
          topics.push(packet.topic);
        },
      };
      const factory =
        'host' in peer
          ? createTcpClient({ ...peer, ...options })
          : adapter === 'browser'
            ? createBrowserClient({ ...peer, ...options })
            : createWebSocketClient({ ...peer, ...options });
      const client = await factory.connect();
      const failure = await client.ping().catch((reason: unknown) => reason);
      expect(failure).toMatchObject({ message: 'Duplicate MQTT CONNACK', code: 0x82 });
      await expect(client.publish('late', '')).rejects.toBe(failure);
      await expect.poll(peer.connections).toBe(0);
      expect(topics).toEqual(['p']);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
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
