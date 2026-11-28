import { expect, test, vi } from 'vitest';
import { createBrowserClient } from '../src/browser.js';
import { createTcpClient } from '../src/index.js';
import {
  createSessionState,
  createTransportClient,
  ProtocolInputError,
  type ByteClientOptions,
  type SessionEnd,
} from '../src/portableClient.js';
import { createWebSocketClient } from '../src/ws.js';
import { exchangeBroker, settle, type Delivery, type ExchangeScript } from './experiments/exchange-broker.js';
import { startTcpPacketPeer } from './experiments/tcp-packet-peer.js';
import { startWebSocketPacketPeer } from './experiments/websocket-packet-peer.js';

type Handlers = Readonly<Pick<ByteClientOptions, 'onMessage' | 'onQosOneMessage' | 'onQosTwoMessage'>>;

const noop = (): void => {};
/** Each handler set a client can have, with the highest QoS it acknowledges. */
const configurations = [
  { name: 'no handler', handlers: {}, acknowledges: 0 },
  { name: 'onMessage', handlers: { onMessage: noop }, acknowledges: 0 },
  { name: 'onQosOneMessage', handlers: { onQosOneMessage: noop }, acknowledges: 1 },
  { name: 'onQosOneMessage and onQosTwoMessage', handlers: { onQosOneMessage: noop, onQosTwoMessage: noop }, acknowledges: 2 },
] as const;

function publication(qos: 0 | 1 | 2, messageId = 7): Delivery {
  return qos === 0 ? { cmd: 'publish', topic: 'a', payload: 'hi' } : { cmd: 'publish', topic: 'a', payload: 'hi', qos, messageId };
}

async function open(handlers: Handlers, script: Readonly<ExchangeScript> = {}) {
  const peer = exchangeBroker(script);
  const ends: SessionEnd[] = [];
  const session = await createTransportClient(peer.transport, {
    clientId: 'receiver',
    onSessionEnd(event) {
      ends.push(event);
    },
    ...handlers,
  }).connect();
  return { session, connection: peer.connection(0), ends };
}

const aboveHandlers = configurations.flatMap(({ name, handlers, acknowledges }) =>
  ([1, 2] as const).filter((qos) => qos > acknowledges).map((qos) => ({ name, handlers, qos })),
);

// MQTT-4.5.0-2 and MQTT-3.3.4-1: every PUBLISH gets its acknowledgment. A client that cannot give it ends the session.
test.each(aboveHandlers)(
  'a QoS $qos PUBLISH to a client with $name ends the session with DISCONNECT 0x82',
  async ({ handlers, qos }: Readonly<{ handlers: Handlers; qos: 1 | 2 }>) => {
    const { session, connection, ends } = await open(handlers);
    connection.deliver(publication(qos));
    await settle();
    expect(connection.frames).toEqual([[0xe0, 1, 0x82]]);
    expect(connection.closes).toEqual([true]);
    const failure = await session.ping().catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(ProtocolInputError);
    expect(failure).toMatchObject({
      code: 'ERR_MQTT_PROTOCOL',
      fatal: true,
      reasonCode: 0x82,
      message: `Inbound QoS ${String(qos)} PUBLISH exceeds the QoS this client acknowledges`,
    });
    expect(ends).toEqual([{ kind: 'error', error: failure }]);
  },
);

test.each(configurations)(
  'a client with $name still receives each PUBLISH up to its QoS',
  async ({ handlers, acknowledges }: Readonly<{ handlers: Handlers; acknowledges: 0 | 1 | 2 }>) => {
    const { session, connection, ends } = await open(handlers);
    connection.deliver(publication(0));
    await settle();
    if (acknowledges >= 1) {
      connection.deliver(publication(1, 3));
      await settle();
    }
    if (acknowledges === 2) {
      connection.deliver(publication(2, 4));
      await settle();
    }
    expect(connection.frames).toEqual(
      [
        [0x40, 2, 0, 3],
        [0x50, 2, 0, 4],
      ].slice(0, acknowledges),
    );
    expect(ends).toEqual([]);
    await session.disconnect();
  },
);

test.each(['createTransportClient', 'createTcpClient', 'createWebSocketClient', 'createBrowserClient'] as const)(
  '%s rejects onQosTwoMessage without onQosOneMessage before the transport opens',
  async (factory) => {
    const peer = exchangeBroker();
    const options = { clientId: 'receiver', onQosTwoMessage: noop };
    // Port 9 is the discard service, which nothing here listens on. A connection attempt would fail with another error.
    const connecting =
      factory === 'createTransportClient'
        ? createTransportClient(peer.transport, options).connect()
        : factory === 'createTcpClient'
          ? createTcpClient({ host: '127.0.0.1', port: 9, ...options }).connect()
          : factory === 'createWebSocketClient'
            ? createWebSocketClient({ url: 'ws://127.0.0.1:9', ...options }).connect()
            : createBrowserClient({ url: 'ws://127.0.0.1:9', ...options }).connect();
    await expect(connecting).rejects.toMatchObject({
      name: 'MqttError',
      code: 'ERR_MQTT_INVALID_ARGUMENT',
      fatal: false,
      message: 'MQTT onQosTwoMessage needs onQosOneMessage',
    });
    expect(peer.connections).toEqual([]);
  },
);

const early = [
  { packet: 'a QoS 0 PUBLISH', command: 'PUBLISH', bytes: [0x30, 5, 0, 1, 0x61, 0, 0x68] },
  { packet: 'a QoS 1 PUBLISH', command: 'PUBLISH', bytes: [0x32, 7, 0, 1, 0x61, 0, 7, 0, 0x68] },
  { packet: 'a QoS 2 PUBLISH', command: 'PUBLISH', bytes: [0x34, 7, 0, 1, 0x61, 0, 7, 0, 0x68] },
  { packet: 'a PUBACK', command: 'PUBACK', bytes: [0x40, 2, 0, 1] },
  { packet: 'a PUBREC', command: 'PUBREC', bytes: [0x50, 2, 0, 1] },
  { packet: 'a PUBREC that refuses', command: 'PUBREC', bytes: [0x50, 3, 0, 1, 0x80] },
  { packet: 'a PUBREL', command: 'PUBREL', bytes: [0x62, 2, 0, 1] },
  { packet: 'a PUBCOMP', command: 'PUBCOMP', bytes: [0x70, 2, 0, 1] },
  { packet: 'a SUBACK', command: 'SUBACK', bytes: [0x90, 4, 0, 1, 0, 0] },
  { packet: 'an UNSUBACK', command: 'UNSUBACK', bytes: [0xb0, 4, 0, 1, 0, 0] },
  { packet: 'a PINGRESP', command: 'PINGRESP', bytes: [0xd0, 0] },
] as const;

// MQTT-3.2.0-1: the broker sends CONNACK before any packet other than AUTH.
test.each(configurations.flatMap(({ name, handlers }) => early.map((vector) => ({ name, handlers, ...vector }))))(
  '$packet before CONNACK ends the attempt of a client with $name without DISCONNECT',
  async ({ handlers, command, bytes }: Readonly<{ handlers: Handlers; command: string; bytes: readonly number[] }>) => {
    const peer = exchangeBroker({ early: bytes });
    const called = vi.fn<() => void>();
    const failure = await createTransportClient(peer.transport, {
      clientId: 'receiver',
      ...handlers,
      ...('onMessage' in handlers ? { onMessage: called } : {}),
      ...('onQosOneMessage' in handlers ? { onQosOneMessage: called } : {}),
      ...('onQosTwoMessage' in handlers ? { onQosTwoMessage: called } : {}),
    })
      .connect()
      .catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(ProtocolInputError);
    expect(failure).toMatchObject({
      code: 'ERR_MQTT_PROTOCOL',
      fatal: true,
      reasonCode: 0x82,
      message: `MQTT ${command} arrived before CONNACK`,
    });
    await settle();
    expect(called).not.toHaveBeenCalled();
    expect(peer.connection(0).frames).toEqual([]);
    expect(peer.connection(0).closes).toEqual([true]);
  },
);

test('a DISCONNECT before CONNACK ends the attempt with the reason code the broker sent', async () => {
  const peer = exchangeBroker({ early: [0xe0, 1, 0x89] });
  await expect(createTransportClient(peer.transport, { clientId: 'receiver' }).connect()).rejects.toMatchObject({
    code: 'ERR_MQTT_BROKER_DISCONNECT',
    reasonCode: 0x89,
  });
  expect(peer.connection(0).frames).toEqual([]);
});

const adapters = ['tcp', 'node-websocket', 'browser'] as const;
type Adapter = (typeof adapters)[number];

// The reply to PINGREQ is the PUBLISH under test, a QoS 0 PUBLISH and PINGRESP.
test.each(
  adapters.flatMap((adapter) => aboveHandlers.map((vector: Readonly<(typeof aboveHandlers)[number]>) => ({ adapter, ...vector }))),
)(
  '$adapter ends the session with DISCONNECT 0x82 on a QoS $qos PUBLISH to a client with $name',
  async ({ adapter, handlers, qos }: Readonly<{ adapter: Adapter; handlers: Handlers; qos: 1 | 2 }>) => {
    const reply = [qos === 1 ? 0x32 : 0x34, 7, 0, 1, 0x61, 0, 7, 0, 0x68, 0x30, 4, 0, 1, 0x62, 0, 0xd0, 0];
    const onMessage = vi.fn<() => void>();
    const options = { clientId: 'receiver', timeoutMs: 1000, ...handlers, onMessage };
    const peer =
      adapter === 'tcp' ? await startTcpPacketPeer('fixed-reply', reply) : await startWebSocketPacketPeer('fixed-reply', reply);
    try {
      const client = await (
        'host' in peer
          ? createTcpClient({ ...peer, ...options })
          : adapter === 'browser'
            ? createBrowserClient({ ...peer, ...options })
            : createWebSocketClient({ ...peer, ...options })
      ).connect();
      const failure = await client.ping().catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(ProtocolInputError);
      expect(failure).toMatchObject({
        code: 'ERR_MQTT_PROTOCOL',
        reasonCode: 0x82,
        message: `Inbound QoS ${String(qos)} PUBLISH exceeds the QoS this client acknowledges`,
      });
      expect(onMessage).not.toHaveBeenCalled();
      await expect(client.ping()).rejects.toBe(failure);
      await expect.poll(() => peer.disconnectReasons).toEqual([0x82]);
    } finally {
      await peer.close();
    }
  },
);

const both: Handlers = { onQosOneMessage: noop, onQosTwoMessage: noop };

/**
 * Connect with a new session state, subscribe at QoS 2 with both handlers and disconnect. The broker grants `granted`, and
 * it answers Session Present true to every later connection that sends Clean Start false.
 */
async function subscribed(granted: 0 | 1 | 2) {
  let sessionPresent = false;
  const peer = exchangeBroker({ connack: () => ({ sessionPresent }), suback: () => granted });
  const options = { clientId: 'resume', sessionExpiryInterval: 60, sessionState: createSessionState() };
  const first = await createTransportClient(peer.transport, { ...options, ...both }).connect();
  await first.subscribe('a', { qos: 2 });
  await first.disconnect();
  const resume = async (handlers: Handlers, cleanStart = false) => {
    sessionPresent = !cleanStart;
    return createTransportClient(peer.transport, { ...options, cleanStart, ...handlers }).connect();
  };
  return { peer, resume };
}

test.each([
  { granted: 2, handlers: { onQosOneMessage: noop }, name: 'onQosOneMessage', needs: 'onQosTwoMessage and onQosOneMessage' },
  { granted: 2, handlers: {}, name: 'no handler', needs: 'onQosTwoMessage and onQosOneMessage' },
  { granted: 1, handlers: {}, name: 'no handler', needs: 'onQosOneMessage' },
] as const)(
  'a session state that was granted QoS $granted rejects a resuming client with $name before the transport opens',
  async ({ granted, handlers, needs }: Readonly<{ granted: 1 | 2; handlers: Handlers; needs: string }>) => {
    const { peer, resume } = await subscribed(granted);
    await expect(resume(handlers)).rejects.toMatchObject({
      name: 'MqttError',
      code: 'ERR_MQTT_INVALID_ARGUMENT',
      fatal: false,
      message: `MQTT session state holds a subscription with QoS ${String(granted)}, which needs ${needs}`,
    });
    expect(peer.connections).toHaveLength(1);
    // The rejected attempt did not claim the state.
    const resumed = await resume(both);
    expect(resumed.connection.sessionPresent).toBe(true);
    await resumed.disconnect();
  },
);

test.each([
  { granted: 1, handlers: { onQosOneMessage: noop }, name: 'onQosOneMessage' },
  { granted: 0, handlers: {}, name: 'no handler' },
] as const)(
  'a session state that was granted QoS $granted lets a client with $name resume',
  async ({ granted, handlers }: Readonly<{ granted: 0 | 1; handlers: Handlers }>) => {
    const { resume } = await subscribed(granted);
    const resumed = await resume(handlers);
    expect(resumed.connection.sessionPresent).toBe(true);
    await resumed.disconnect();
  },
);

test('Clean Start true ignores what the session state was granted, and the new session starts without a grant', async () => {
  const { peer, resume } = await subscribed(2);
  const clean = await resume({}, true);
  expect(clean.connection.sessionPresent).toBe(false);
  await clean.disconnect();
  // Session Present false on the clean connection dropped the grant, so a later resume needs no handler.
  const resumed = await resume({});
  await resumed.disconnect();
  expect(peer.connections).toHaveLength(3);
});

test('Session Present false drops what the session state was granted', async () => {
  const sessionState = createSessionState();
  const peer = exchangeBroker();
  const options = { clientId: 'resume', sessionExpiryInterval: 60, sessionState, cleanStart: false };
  const first = await createTransportClient(peer.transport, { ...options, ...both }).connect();
  await first.subscribe('a', { qos: 2 });
  await first.disconnect();
  // The broker lost the session and answers Session Present false to a client that still has both handlers.
  const second = await createTransportClient(peer.transport, { ...options, ...both }).connect();
  await second.disconnect();
  const third = await createTransportClient(peer.transport, options).connect();
  await third.disconnect();
  expect(peer.connections).toHaveLength(3);
});

test('a later grant of a lower QoS does not lower what the session state was granted', async () => {
  const peer = exchangeBroker({
    connack: (index) => ({ sessionPresent: index > 1 }),
    suback: (topic) => (topic === 'a' ? 2 : 0),
  });
  const options = { clientId: 'resume', sessionExpiryInterval: 60, sessionState: createSessionState() };
  const first = await createTransportClient(peer.transport, { ...options, ...both }).connect();
  await first.subscribe('a', { qos: 2 });
  await first.subscribe('b', { qos: 2 });
  await first.disconnect();
  await expect(createTransportClient(peer.transport, { ...options, cleanStart: false }).connect()).rejects.toMatchObject({
    code: 'ERR_MQTT_INVALID_ARGUMENT',
    message: 'MQTT session state holds a subscription with QoS 2, which needs onQosTwoMessage and onQosOneMessage',
  });
});

test('an unsubscribe does not lower what the session state was granted', async () => {
  const sessionState = createSessionState();
  const peer = exchangeBroker({
    connack: (index) => ({ sessionPresent: index > 1 }),
    answer: (packet) => (packet.cmd === 'unsubscribe' ? [] : undefined),
  });
  const options = { clientId: 'resume', sessionExpiryInterval: 60, sessionState };
  const first = await createTransportClient(peer.transport, { ...options, ...both }).connect();
  await first.subscribe('a', { qos: 2 });
  const unsubscribing = first.unsubscribe('a');
  await settle();
  peer.connection(0).deliverBytes([0xb0, 4, 0, 2, 0, 0]);
  await unsubscribing;
  await first.disconnect();
  await expect(createTransportClient(peer.transport, { ...options, cleanStart: false }).connect()).rejects.toMatchObject({
    code: 'ERR_MQTT_INVALID_ARGUMENT',
  });
});

test('a resumed broker session that the session state does not know ends on a PUBLISH above the handlers', async () => {
  // Another process subscribed at QoS 2 under this Client Identifier. The new state has no record of it.
  const peer = exchangeBroker({ connack: () => ({ sessionPresent: true }) });
  const ends: SessionEnd[] = [];
  const session = await createTransportClient(peer.transport, {
    clientId: 'resume',
    cleanStart: false,
    sessionExpiryInterval: 60,
    sessionState: createSessionState(),
    onSessionEnd(event) {
      ends.push(event);
    },
  }).connect();
  expect(session.connection.sessionPresent).toBe(true);
  peer.connection(0).deliver(publication(2));
  await settle();
  expect(peer.connection(0).frames).toEqual([[0xe0, 1, 0x82]]);
  expect(ends).toMatchObject([{ kind: 'error', error: { code: 'ERR_MQTT_PROTOCOL', reasonCode: 0x82 } }]);
});
