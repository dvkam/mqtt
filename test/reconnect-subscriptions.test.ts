import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createSessionState, createTransportClient, type ByteClientOptions } from '../src/portableClient.js';
import { createReconnectingClient, type ReconnectEvent, type ReconnectOptions } from '../src/reconnect.js';
import type { ClientFactory } from '../src/session.js';
import type { ReadonlyDeep } from '../src/util/bytes.js';
import { broker, type Script } from './experiments/scripted-broker.js';

interface Mode {
  readonly reconnect: ReconnectOptions;
  readonly factory: Partial<ByteClientOptions>;
}

// The two ways a reconnecting client keeps one MQTT session across connections. With `resume` it shares its own session
// state and sends Clean Start true first. With a session state from the caller, every attempt sends Clean Start false.
const modes: readonly (readonly [string, () => Mode])[] = [
  ['resume', () => ({ reconnect: { resume: true }, factory: {} })],
  [
    'a sessionState in the factory options',
    () => ({ reconnect: {}, factory: { cleanStart: false, sessionState: createSessionState() } }),
  ],
];

function supervise(
  script: Readonly<Script>,
  mode: ReadonlyDeep<Mode>,
  reconnect: Readonly<ReconnectOptions> = {},
  /** Replaces the factory of the nth attempt, counted from 0. `end` ends the connection that the attempt opens. */
  wrap: (factory: Readonly<ClientFactory>, attempt: number, end: () => void) => ClientFactory = (factory) => factory,
) {
  const peer = broker(script);
  const events: ReconnectEvent[] = [];
  const client = createReconnectingClient<ByteClientOptions>(
    (options: ReadonlyDeep<ByteClientOptions>) => {
      const attempt = peer.connections.length;
      return wrap(createTransportClient(peer.transport, options), attempt, () => {
        peer.connections[attempt]?.end();
      });
    },
    { clientId: 'intents', sessionExpiryInterval: 600, onQosOneMessage() {}, ...mode.factory },
    {
      // Every retry delay is 50 ms.
      random: () => 0,
      initialDelayMs: 100,
      maxDelayMs: 100,
      subscriptions: [{ topic: 'commands/#', qos: 1 }],
      ...mode.reconnect,
      ...reconnect,
      onReconnect(event) {
        events.push(event);
      },
    },
  );
  /** Ends the nth connection, counted from 0, and waits until the next attempt has run. */
  const reconnectAfter = async (index: number): Promise<void> => {
    peer.connections[index]?.end();
    await vi.advanceTimersByTimeAsync(50);
  };
  return { peer, client, events, reconnectAfter };
}

const granted = { topic: 'commands/#', qos: 1, result: { grantedQos: 1 } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

test.each(modes)('subscribes on a resumed session whose SUBACK never arrived, with %s', async (_name, mode) => {
  const { peer, client, events, reconnectAfter } = supervise(
    { sessionPresent: (connection) => connection > 1, suback: (_topic, connection) => (connection === 1 ? undefined : 1) },
    mode(),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(peer.received(0).commands).toEqual(['connect', 'subscribe']);
  expect(events).toEqual([]);
  await reconnectAfter(0);
  await client.session();
  expect(peer.connections[1]?.packets[0]).toMatchObject({ cmd: 'connect', cleanStart: false });
  expect(peer.received(1).topics).toEqual(['commands/#']);
  expect(events.at(-1)).toMatchObject({ kind: 'connected', generation: 1, resumed: true, subscriptions: [granted] });
  await client.disconnect();
});

test.each(modes)('subscribes on a resumed session whose SUBSCRIBE was never written, with %s', async (_name, mode) => {
  const { peer, client, events } = supervise(
    { sessionPresent: (connection) => connection > 1, failSubscribeWrite: (connection) => connection === 1, suback: () => 1 },
    mode(),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toMatchObject([{ kind: 'retrying', error: { code: 'ERR_MQTT_TRANSPORT', message: 'write EPIPE' } }]);
  expect(peer.received(0).commands).toEqual(['connect']);
  await vi.advanceTimersByTimeAsync(50);
  await client.session();
  expect(peer.connections[1]?.packets[0]).toMatchObject({ cmd: 'connect', cleanStart: false });
  expect(peer.received(1).topics).toEqual(['commands/#']);
  expect(events.at(-1)).toMatchObject({ kind: 'connected', generation: 1, resumed: true, subscriptions: [granted] });
  await client.disconnect();
});

test.each(modes)('makes no SUBSCRIBE on a resumed session that answered every intent, with %s', async (_name, mode) => {
  const { peer, client, events, reconnectAfter } = supervise(
    { sessionPresent: (connection) => connection > 1, suback: () => 1 },
    mode(),
  );
  await client.session();
  expect(events.at(-1)).toMatchObject({ kind: 'connected', resumed: false, subscriptions: [granted] });
  await reconnectAfter(0);
  await client.session();
  await reconnectAfter(1);
  await client.session();
  for (const index of [1, 2]) expect(peer.received(index).commands).toEqual(['connect']);
  expect(events.at(-1)).toMatchObject({ kind: 'connected', generation: 3, resumed: true, subscriptions: [] });
  await client.disconnect();
});

test.each(modes)(
  'subscribes again after Session Present false, and not on the resume that follows, with %s',
  async (_name, mode) => {
    const { peer, client, events, reconnectAfter } = supervise(
      { sessionPresent: (connection) => connection === 3, suback: () => 1 },
      mode(),
    );
    await client.session();
    await reconnectAfter(0);
    await client.session();
    expect(peer.received(1).topics).toEqual(['commands/#']);
    expect(events.at(-1)).toMatchObject({ kind: 'connected', generation: 2, resumed: false, subscriptions: [granted] });
    await reconnectAfter(1);
    await client.session();
    expect(peer.received(2).commands).toEqual(['connect']);
    expect(events.at(-1)).toMatchObject({ kind: 'connected', generation: 3, resumed: true, subscriptions: [] });
    await client.disconnect();
  },
);

test.each(modes)('Session Present false clears what an earlier SUBACK told the client, with %s', async (_name, mode) => {
  const { peer, client, events, reconnectAfter } = supervise(
    { sessionPresent: (connection) => connection === 3, suback: (_topic, connection) => (connection === 2 ? undefined : 1) },
    mode(),
  );
  await client.session();
  await reconnectAfter(0);
  expect(peer.received(1).commands).toEqual(['connect', 'subscribe']);
  await reconnectAfter(1);
  await client.session();
  expect(peer.received(2).topics).toEqual(['commands/#']);
  expect(events.at(-1)).toMatchObject({ kind: 'connected', generation: 2, resumed: true, subscriptions: [granted] });
  await client.disconnect();
});

test('resetSession() clears what an earlier SUBACK told the client', async () => {
  const { peer, client, events, reconnectAfter } = supervise(
    { sessionPresent: (connection) => connection > 2, suback: (_topic, connection) => (connection === 2 ? undefined : 1) },
    { reconnect: { resume: true }, factory: {} },
  );
  await client.session();
  client.resetSession();
  await reconnectAfter(0);
  expect(peer.connections[1]?.packets[0]).toMatchObject({ cmd: 'connect', cleanStart: true });
  expect(peer.received(1).commands).toEqual(['connect', 'subscribe']);
  await reconnectAfter(1);
  await client.session();
  expect(peer.connections[2]?.packets[0]).toMatchObject({ cmd: 'connect', cleanStart: false });
  expect(peer.received(2).topics).toEqual(['commands/#']);
  expect(events.at(-1)).toMatchObject({ kind: 'connected', generation: 2, resumed: true, subscriptions: [granted] });
  await reconnectAfter(2);
  await client.session();
  expect(peer.received(3).commands).toEqual(['connect']);
  await client.disconnect();
});

test.each(modes)('a refused SUBACK is an answer, so a resumed session gets no second SUBSCRIBE, with %s', async (_name, mode) => {
  const { peer, client, events, reconnectAfter } = supervise(
    { sessionPresent: (connection) => connection > 1, suback: (topic) => (topic === 'denied/#' ? 0x87 : 1) },
    mode(),
    { subscriptions: [{ topic: 'commands/#', qos: 1 }, { topic: 'denied/#' }] },
  );
  await client.session();
  expect(events.at(-1)).toMatchObject({
    kind: 'connected',
    subscriptions: [granted, { topic: 'denied/#', qos: 0, error: { code: 'ERR_MQTT_REFUSED', reasonCode: 0x87, fatal: false } }],
  });
  await reconnectAfter(0);
  await client.session();
  expect(peer.received(1).commands).toEqual(['connect']);
  expect(events.at(-1)).toMatchObject({ kind: 'connected', resumed: true, subscriptions: [] });
  await client.disconnect();
});

test.each(modes)('makes every subscription again when one SUBACK is missing, with %s', async (_name, mode) => {
  const { peer, client, events, reconnectAfter } = supervise(
    {
      sessionPresent: (connection) => connection > 1,
      suback: (topic, connection) => (connection === 1 && topic === 'alerts' ? undefined : 1),
    },
    mode(),
    {
      subscriptions: [
        { topic: 'commands/#', qos: 1 },
        { topic: 'alerts', qos: 1 },
      ],
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(peer.received(0).topics).toEqual(['commands/#', 'alerts']);
  await reconnectAfter(0);
  await client.session();
  expect(peer.received(1).topics).toEqual(['commands/#', 'alerts']);
  expect(events.at(-1)).toMatchObject({
    kind: 'connected',
    resumed: true,
    subscriptions: [granted, { topic: 'alerts', qos: 1, result: { grantedQos: 1 } }],
  });
  await client.disconnect();
});

test.each(modes)('tries an intent again that the client rejected before it wrote a SUBSCRIBE, with %s', async (_name, mode) => {
  const { peer, client, events, reconnectAfter } = supervise(
    { sessionPresent: (connection) => connection > 1, suback: () => 1 },
    mode(),
    {
      // The factory options have no onQosTwoMessage handler, so the client rejects the second intent itself.
      subscriptions: [
        { topic: 'commands/#', qos: 1 },
        { topic: 'exact/#', qos: 2 },
      ],
    },
  );
  const outcomes = [granted, { topic: 'exact/#', qos: 2, error: { code: 'ERR_MQTT_INVALID_ARGUMENT', fatal: false } }];
  await client.session();
  expect(events.at(-1)).toMatchObject({ kind: 'connected', resumed: false, subscriptions: outcomes });
  await reconnectAfter(0);
  await client.session();
  expect(peer.received(1).topics).toEqual(['commands/#']);
  expect(events.at(-1)).toMatchObject({ kind: 'connected', resumed: true, subscriptions: outcomes });
  await client.disconnect();
});

test.each(modes)('subscribes on a session that the broker kept from an earlier client, with %s', async (_name, mode) => {
  const { reconnect, factory } = mode();
  const { peer, client, events } = supervise(
    { sessionPresent: () => true, suback: () => 1 },
    { reconnect, factory: { ...factory, cleanStart: false } },
  );
  await client.session();
  expect(peer.received(0).topics).toEqual(['commands/#']);
  expect(events).toMatchObject([{ kind: 'connected', generation: 1, resumed: true, subscriptions: [granted] }]);
  await client.disconnect();
});

test.each(modes)('subscribes on a resumed session after an attempt whose CONNACK never arrived, with %s', async (_name, mode) => {
  // The broker lost the session. The second CONNECT starts a new one, and its CONNACK with Session Present false is lost.
  const { peer, client, events, reconnectAfter } = supervise(
    {
      connack: (connection) => (connection === 2 ? undefined : 0),
      sessionPresent: (connection) => connection === 3,
      suback: () => 1,
    },
    mode(),
  );
  await client.session();
  await reconnectAfter(0);
  expect(peer.received(1).commands).toEqual(['connect']);
  await reconnectAfter(1);
  await client.session();
  expect(peer.received(2).topics).toEqual(['commands/#']);
  expect(events.at(-1)).toMatchObject({ kind: 'connected', generation: 2, resumed: true, subscriptions: [granted] });
  await client.disconnect();
});

test.each(modes)(
  'subscribes again when the session ended after its SUBACK and before the connected event, with %s',
  async (_name, mode) => {
    const { reconnect, factory } = mode();
    const ended = Promise.withResolvers<void>();
    const { peer, client, events } = supervise(
      { sessionPresent: (connection) => connection > 1, suback: () => 1 },
      {
        reconnect,
        factory: {
          ...factory,
          onSessionEnd() {
            ended.resolve();
          },
        },
      },
      {},
      (inner, attempt, end) => ({
        async connect() {
          const session = await inner.connect();
          if (attempt > 0) return session;
          return {
            ...session,
            // The SUBACK of the first connection arrives, and the session ends before the reconnecting client reads the result.
            async subscribe(topic, options) {
              const result = await session.subscribe(topic, options);
              end();
              await ended.promise;
              return result;
            },
          };
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(50);
    await client.session();
    expect(peer.received(0).commands).toEqual(['connect', 'subscribe']);
    expect(peer.received(1).topics).toEqual(['commands/#']);
    expect(events).toMatchObject([
      { kind: 'retrying' },
      { kind: 'connected', generation: 1, resumed: true, subscriptions: [granted] },
    ]);
    await client.disconnect();
  },
);
