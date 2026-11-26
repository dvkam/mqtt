import { expect, test, vi } from 'vitest';
import { createBrowserClient as browserEntry, MqttError as BrowserMqttError } from '../src/browser.js';
import { createTransportClient, MqttError as RootMqttError, type ByteTransport } from '../src/index.js';
import { MqttError as PortableMqttError } from '../src/portableClient.js';
import { createTcpClient } from '../src/tcpClient.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import type { UserProperty } from '../src/codec.js';
import { isMqttError, MqttError, type MqttErrorCode } from '../src/mqttError.js';
import { connectPortable, type PacketTransport } from '../src/portable.js';
import type { SessionEnd } from '../src/session.js';

// What a test needs to answer a sent packet. Missing identifiers and QoS read as zero.
type Sent = Readonly<{ cmd: string; messageId: number; qos: number }>;
type Reply =
  | Readonly<{
      cmd: 'connack';
      sessionPresent: false;
      reasonCode: number;
      reasonString?: string;
      userProperties?: readonly UserProperty[];
    }>
  | Readonly<{ cmd: 'suback'; messageId: number; granted: readonly number[] }>
  | Readonly<{ cmd: 'puback'; messageId: number; reasonCode: number }>
  | Readonly<{ cmd: 'pingresp' }>
  | Readonly<{ cmd: 'disconnect'; reasonCode: number; reasonString?: string; userProperties?: readonly UserProperty[] }>;
type Receive = (this: void, packet: Reply) => void;
type Responder = (this: void, packet: Sent, receive: Receive) => void | Promise<void>;

// Answers CONNECT, SUBSCRIBE and PINGREQ unless the test passes its own responder. A returned promise holds the write.
function peer(reply: Responder = answer): Readonly<{ transport: PacketTransport; receive: Receive }> {
  let deliver: Receive | undefined;
  const receive: Receive = (packet) => {
    deliver?.(packet);
  };
  const transport: PacketTransport = {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- PacketTransport.send in src/portable.ts receives the session's ClientPacket, whose PUBLISH payload is a native Uint8Array.
    async send(packet) {
      const messageId = 'messageId' in packet && typeof packet.messageId === 'number' ? packet.messageId : 0;
      const qos = 'qos' in packet && typeof packet.qos === 'number' ? packet.qos : 0;
      await reply({ cmd: packet.cmd, messageId, qos }, receive);
    },
    listen(onPacket) {
      deliver = onPacket;
      return () => {};
    },
    async close() {},
  };
  return { transport, receive };
}

function answer(packet: Sent, receive: Receive): void {
  if (packet.cmd === 'connect') receive({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
  if (packet.cmd === 'subscribe') receive({ cmd: 'suback', messageId: packet.messageId, granted: [packet.qos] });
  if (packet.cmd === 'pingreq') receive({ cmd: 'pingresp' });
}

function coded(code: MqttErrorCode, fatal: boolean, extra: Readonly<Record<string, unknown>> = {}): unknown {
  return expect.objectContaining({ name: 'MqttError', code, fatal, ...extra });
}

test('an invalid argument is not fatal and leaves the session usable', async () => {
  const client = await connectPortable(peer().transport, { clientId: 'invalid' });
  await expect(client.publish('a/#', 'x')).rejects.toEqual(coded('ERR_MQTT_INVALID_ARGUMENT', false));
  await expect(client.subscribe('a/#/b')).rejects.toEqual(coded('ERR_MQTT_INVALID_ARGUMENT', false));
  await expect(client.subscribe('a', { qos: 1 })).rejects.toEqual(coded('ERR_MQTT_INVALID_ARGUMENT', false));
  await client.publish('a', 'still active');
  await client.disconnect();
});

test('a full publication queue is a non-fatal capacity rejection', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const broker = peer(async (packet, receive) => {
    if (packet.cmd === 'publish') await held;
    else answer(packet, receive);
  });
  const client = await connectPortable(broker.transport, { clientId: 'capacity', maxPendingPublishes: 1 });
  const first = client.publish('a', 'first');
  const second = client.publish('a', 'second');
  await expect(second).rejects.toEqual(coded('ERR_MQTT_CAPACITY', false));
  release();
  await first;
  await client.disconnect();
});

test('a second ping while one awaits PINGRESP is a non-fatal capacity rejection', async () => {
  const broker = peer((packet, receive) => {
    if (packet.cmd !== 'pingreq') answer(packet, receive);
  });
  const client = await connectPortable(broker.transport, { clientId: 'ping' });
  const first = client.ping();
  const second = client.ping();
  await expect(second).rejects.toEqual(coded('ERR_MQTT_CAPACITY', false));
  broker.receive({ cmd: 'pingresp' });
  await first;
  await client.disconnect();
});

test('an operation timeout is fatal and becomes the outcome of later work', async () => {
  const broker = peer((packet, receive) => {
    if (packet.cmd !== 'pingreq') answer(packet, receive);
  });
  const client = await connectPortable(broker.transport, { clientId: 'timeout', timeoutMs: 5 });
  const failure: unknown = await client.ping().catch((error: unknown) => error);
  expect(failure).toEqual(coded('ERR_MQTT_TIMEOUT', true));
  await expect(client.publish('a', 'late')).rejects.toBe(failure);
});

test('work after disconnect reports that the client is closing', async () => {
  const client = await connectPortable(peer().transport, { clientId: 'closing' });
  const closing = client.disconnect();
  await expect(client.publish('a', 'late')).rejects.toEqual(coded('ERR_MQTT_CLOSING', true));
  await expect(client.ping()).rejects.toEqual(coded('ERR_MQTT_CLOSING', true));
  await closing;
  await expect(client.subscribe('a')).rejects.toEqual(coded('ERR_MQTT_CLOSING', true));
});

test('a broker DISCONNECT carries its reason code, Reason String and User Properties', async () => {
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'broker-disconnect' });
  broker.receive({
    cmd: 'disconnect',
    reasonCode: 0x8b,
    reasonString: 'server shutting down',
    userProperties: [['node', 'b']],
  });
  await expect(client.ping()).rejects.toEqual(
    coded('ERR_MQTT_BROKER_DISCONNECT', true, {
      reasonCode: 0x8b,
      reasonString: 'server shutting down',
      userProperties: [['node', 'b']],
    }),
  );
});

test('a refused CONNACK is fatal and keeps the reason code apart from the error code', async () => {
  const broker = peer((packet, receive) => {
    if (packet.cmd === 'connect') receive({ cmd: 'connack', sessionPresent: false, reasonCode: 0x87 });
  });
  await expect(connectPortable(broker.transport, { clientId: 'refused' })).rejects.toEqual(
    coded('ERR_MQTT_REFUSED', true, { reasonCode: 0x87 }),
  );
});

test('a refused SUBACK is not fatal', async () => {
  const broker = peer((packet, receive) => {
    if (packet.cmd === 'subscribe') receive({ cmd: 'suback', messageId: packet.messageId, granted: [0x87] });
    else answer(packet, receive);
  });
  const client = await connectPortable(broker.transport, { clientId: 'suback' });
  await expect(client.subscribe('a')).rejects.toEqual(coded('ERR_MQTT_REFUSED', false, { reasonCode: 0x87 }));
  await client.publish('a', 'still active');
  await client.disconnect();
});

test('a refused PUBACK is not fatal', async () => {
  const broker = peer((packet, receive) => {
    if (packet.cmd === 'publish' && packet.qos === 1) receive({ cmd: 'puback', messageId: packet.messageId, reasonCode: 0x97 });
    else answer(packet, receive);
  });
  const client = await connectPortable(broker.transport, { clientId: 'puback' });
  await expect(client.publish('a', 'quota', { qos: 1 })).rejects.toEqual(coded('ERR_MQTT_REFUSED', false, { reasonCode: 0x97 }));
  await client.publish('a', 'still active');
  await client.disconnect();
});

test('a protocol violation is fatal', async () => {
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'protocol' });
  broker.receive({ cmd: 'puback', messageId: 0, reasonCode: 0 });
  await expect(client.ping()).rejects.toEqual(coded('ERR_MQTT_PROTOCOL', true));
});

test('isMqttError narrows by class and code', () => {
  const error: unknown = new MqttError('ERR_MQTT_CAPACITY', 'full', { fatal: false });
  expect(isMqttError(error)).toBe(true);
  expect(isMqttError(error, 'ERR_MQTT_CAPACITY')).toBe(true);
  expect(isMqttError(error, 'ERR_MQTT_TIMEOUT')).toBe(false);
  expect(isMqttError(new Error('full'))).toBe(false);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toHaveProperty('reasonCode');
});

test('a peer that closes the TCP connection ends the session with a transport error', async () => {
  const peer = await startTcpPacketPeer('default');
  let ended = (_end: SessionEnd) => {};
  const end = new Promise<SessionEnd>((resolve) => {
    ended = resolve;
  });
  const options = { host: peer.host, port: peer.port, clientId: 'closed', onSessionEnd: ended };
  const client = await createTcpClient(options).connect();
  await peer.close();
  expect(await end).toEqual({ kind: 'error', error: coded('ERR_MQTT_TRANSPORT', true) });
  await expect(client.ping()).rejects.toEqual(coded('ERR_MQTT_TRANSPORT', true));
});

test('an abort passes its own reason through, even a non-fatal MqttError', async () => {
  const peer = await startTcpPacketPeer('default');
  const controller = new AbortController();
  const client = await createTcpClient({
    host: peer.host,
    port: peer.port,
    clientId: 'abort',
    signal: controller.signal,
  }).connect();
  const reason = new MqttError('ERR_MQTT_CAPACITY', 'caller gave up', { fatal: false });
  controller.abort(reason);
  try {
    await expect(client.publish('a', 'late')).rejects.toBe(reason);
  } finally {
    await peer.close();
  }
});

test('fatal defaults by code', () => {
  expect(new MqttError('ERR_MQTT_CAPACITY', 'full').fatal).toBe(false);
  expect(new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'bad').fatal).toBe(false);
  expect(new MqttError('ERR_MQTT_REFUSED', 'refused').fatal).toBe(true);
  expect(new MqttError('ERR_MQTT_REFUSED', 'refused', { fatal: false }).fatal).toBe(false);
  expect(new MqttError('ERR_MQTT_TRANSPORT', 'closed').fatal).toBe(true);
});

test('every entry exports the same MqttError class', () => {
  expect(typeof browserEntry).toBe('function');
  expect(RootMqttError).toBe(MqttError);
  expect(BrowserMqttError).toBe(MqttError);
  expect(PortableMqttError).toBe(MqttError);
});

test('a refused CONNACK carries the Reason String and User Properties', async () => {
  const broker = peer((packet, receive) => {
    if (packet.cmd === 'connect')
      receive({
        cmd: 'connack',
        sessionPresent: false,
        reasonCode: 0x87,
        reasonString: 'not authorized',
        userProperties: [['realm', 'sensors']],
      });
  });
  await expect(connectPortable(broker.transport, { clientId: 'refused-reason' })).rejects.toEqual(
    coded('ERR_MQTT_REFUSED', true, {
      reasonCode: 0x87,
      reasonString: 'not authorized',
      userProperties: [['realm', 'sensors']],
    }),
  );
});

test('an onMessage handler that rethrows a non-fatal rejection ends the session with a fatal copy', async () => {
  const peerSocket = await startTcpPacketPeer('default');
  const rethrown = new MqttError('ERR_MQTT_CAPACITY', 'full', { fatal: false });
  try {
    const client = await createTcpClient({
      host: peerSocket.host,
      port: peerSocket.port,
      clientId: 'rethrow',
      onMessage() {
        throw rethrown;
      },
    }).connect();
    await client.subscribe('a');
    await client.publish('a', 'echo');
    await expect
      .poll(async () => client.ping().catch((error: unknown) => error))
      .toEqual(coded('ERR_MQTT_CAPACITY', true, { cause: rethrown }));
    expect(rethrown.fatal).toBe(false);
  } finally {
    await peerSocket.close();
  }
});

test('a transport that rejects a write with a value that is not an Error gets one coded failure', async () => {
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'non-error' });
  vi.spyOn(broker.transport, 'send').mockRejectedValueOnce('socket gone');
  const failure: unknown = await client.ping().catch((error: unknown) => error);
  expect(failure).toEqual(coded('ERR_MQTT_TRANSPORT', true, { cause: 'socket gone' }));
  await expect(client.publish('a', 'late')).rejects.toBe(failure);
});

test('an opener that rejects with a value that is not an Error gets a coded failure', async () => {
  const transport: ByteTransport = { name: 'Failing', open: vi.fn<ByteTransport['open']>().mockRejectedValue('refused') };
  await expect(createTransportClient(transport, { clientId: 'open' }).connect()).rejects.toEqual(
    coded('ERR_MQTT_TRANSPORT', true, { cause: 'refused' }),
  );
});

test('a connection signal aborted with a value that is not an Error keeps it as the cause', async () => {
  const transport: ByteTransport = { name: 'Unused', open: vi.fn<ByteTransport['open']>() };
  const controller = new AbortController();
  controller.abort('stop');
  await expect(createTransportClient(transport, { clientId: 'abort', signal: controller.signal }).connect()).rejects.toEqual(
    expect.objectContaining({ name: 'AbortError', code: 'ERR_MQTT_ABORTED', fatal: true, cause: 'stop' }),
  );
});
