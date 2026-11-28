import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ByteInbound, ByteTransport } from '../src/byteTransport.js';
import { encodePacket, PacketDecoder, type BrokerPacket, type ClientPacket } from '../src/codec.js';
import {
  createSessionState,
  createTransportClient,
  type ByteClientOptions,
  type SessionOptions,
  type SessionState,
} from '../src/portableClient.js';
import { createReconnectingClient, type ReconnectEvent, type ReconnectOptions } from '../src/reconnect.js';
import { bindSessionState } from '../src/sessionState.js';
import type { PublishMessage } from '../src/messageProperties.js';
import type { QosOneMessage } from '../src/session.js';
import type { ReadonlyBytes, ReadonlyDeep } from '../src/util/bytes.js';

type Connack = Extract<BrokerPacket, { cmd: 'connack' }>;
type Publish = Extract<ClientPacket, { cmd: 'publish' }>;

interface Connection {
  readonly packets: ClientPacket[];
  /** The size of each PUBLISH the broker read, in bytes. */
  readonly publishBytes: number[];
  deliver(packet: ReadonlyDeep<BrokerPacket>): void;
  /** Sends bytes the codec cannot encode, such as a PUBLISH with a Topic Alias. */
  deliverBytes(bytes: readonly number[]): void;
  end(): void;
}

interface Script {
  /** The CONNACK fields for the nth connection, starting at 1, besides the cmd and a reason code of 0. */
  connack?: (connection: number) => Partial<Omit<Connack, 'cmd'>>;
  /** Whether the broker answers a QoS 1 PUBLISH on the nth connection with PUBACK. Defaults to true. */
  puback?: (connection: number) => boolean;
  /**
   * The writer's `bufferedBytes` on the nth connection, given the PUBLISH bytes written on it so far and the bytes of the
   * writes that have not settled. Defaults to 0. Each write settles one microtask after it starts.
   */
  buffered?: (connection: number, publishBytes: number, pendingBytes: number) => number;
  /** Whether a write of this many bytes on the nth connection never settles and never reaches the broker. */
  hold?: (connection: number, bytes: number) => boolean;
  /**
   * How many milliseconds a write of a packet type other than CONNECT takes to settle on the nth connection. The type is
   * the high nibble of the first byte, 3 for PUBLISH and 14 for DISCONNECT. Defaults to one microtask.
   */
  settleMs?: (connection: number, type: number) => number | undefined;
  /** How many milliseconds the broker waits before it sends a PUBACK on the nth connection. Defaults to none. */
  pubackDelayMs?: (connection: number) => number;
}

// A broker over the byte transport. It answers CONNECT, SUBSCRIBE and, when the script says so, QoS 1 PUBLISH. It records
// every packet it reads.
function broker(script: Readonly<Script> = {}) {
  const connections: Connection[] = [];
  const transport: ByteTransport = {
    name: 'Session broker',
    async open(inbound: Readonly<ByteInbound>) {
      const decoder = new PacketDecoder();
      const index = connections.length + 1;
      const reply = (packet: ReadonlyDeep<BrokerPacket>): void => {
        queueMicrotask(() => {
          inbound.bytes(encodePacket(packet));
        });
      };
      const connection: Connection = {
        packets: [],
        publishBytes: [],
        deliver(packet: ReadonlyDeep<BrokerPacket>) {
          inbound.bytes(encodePacket(packet));
        },
        deliverBytes(bytes) {
          inbound.bytes(Uint8Array.from(bytes));
        },
        end() {
          inbound.end();
        },
      };
      connections.push(connection);
      let pending = 0;
      return Promise.resolve({
        get bufferedBytes() {
          let written = 0;
          for (const bytes of connection.publishBytes) written += bytes;
          return script.buffered?.(index, written, pending) ?? 0;
        },
        async write(bytes: ReadonlyBytes) {
          if (script.hold?.(index, bytes.byteLength) === true) await new Promise<void>(() => {});
          pending += bytes.byteLength;
          for (const packet of decoder.push(bytes)) {
            if (packet.cmd === 'connack' || packet.cmd === 'suback' || packet.cmd === 'unsuback' || packet.cmd === 'pingresp')
              continue;
            connection.packets.push(packet);
            if (packet.cmd === 'connect')
              reply({ cmd: 'connack', sessionPresent: false, reasonCode: 0, ...script.connack?.(index) });
            if (packet.cmd === 'subscribe') reply({ cmd: 'suback', messageId: packet.messageId, granted: [0] });
            if (packet.cmd === 'publish') connection.publishBytes.push(bytes.byteLength);
            if (packet.cmd === 'publish' && packet.qos === 1 && (script.puback?.(index) ?? true)) {
              const puback: BrokerPacket = { cmd: 'puback', messageId: packet.messageId, reasonCode: 0 };
              const delay = script.pubackDelayMs?.(index);
              if (delay === undefined) reply(puback);
              else
                setTimeout(() => {
                  inbound.bytes(encodePacket(puback));
                }, delay);
            }
          }
          const type = (bytes[0] ?? 0) >> 4;
          const settleMs = type === 1 ? undefined : script.settleMs?.(index, type);
          await (settleMs === undefined
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                setTimeout(resolve, settleMs);
              }));
          pending -= bytes.byteLength;
        },
        async close() {},
      });
    },
  };
  const publishes = (index: number): Publish[] => {
    const list: Publish[] = [];
    for (const packet of connections[index]?.packets ?? []) if (packet.cmd === 'publish') list.push(packet);
    return list;
  };
  const commands = (index: number): string[] => {
    const list: string[] = [];
    for (const packet of connections[index]?.packets ?? []) list.push(packet.cmd);
    return list;
  };
  /** The topic, Packet Identifier and DUP flag of each PUBLISH on the nth connection, counted from 0. */
  const sent = (index: number): [string, number | undefined, boolean | undefined][] => {
    const list: [string, number | undefined, boolean | undefined][] = [];
    for (const packet of publishes(index)) list.push([packet.topic, packet.messageId, packet.dup]);
    return list;
  };
  /** The Packet Identifier of each SUBSCRIBE on the nth connection, counted from 0. */
  const subscribed = (index: number): number[] => {
    const list: number[] = [];
    for (const packet of connections[index]?.packets ?? []) if (packet.cmd === 'subscribe') list.push(packet.messageId);
    return list;
  };
  /** The CONNECT of the nth connection, counted from 0. */
  const connect = (index: number) => {
    const packet = connections[index]?.packets[0];
    if (packet?.cmd !== 'connect') throw new Error('Expected CONNECT');
    return packet;
  };
  return { transport, connections, publishes, commands, sent, subscribed, connect };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const client = (transport: Readonly<ByteTransport>, options: Readonly<SessionOptions & { timeoutMs?: number }> = {}) =>
  createTransportClient(transport, { clientId: 'resume', onQosOneMessage() {}, ...options });

test('CONNECT carries Clean Start false and the Session Expiry Interval, and CONNACK may lower the interval', async () => {
  const peer = broker({
    connack: (index) => (index === 1 ? { sessionPresent: true } : index === 2 ? { sessionExpiryInterval: 30 } : {}),
  });
  const first = await client(peer.transport, {
    cleanStart: false,
    sessionExpiryInterval: 600,
    sessionState: createSessionState(),
  }).connect();
  expect(peer.connect(0)).toMatchObject({ cleanStart: false, sessionExpiryInterval: 600 });
  expect(first.connection).toMatchObject({ sessionPresent: true, sessionExpiryInterval: 600 });
  await first.disconnect();
  const second = await client(peer.transport, { sessionExpiryInterval: 600 }).connect();
  expect(peer.connect(1)).toMatchObject({ cleanStart: true, sessionExpiryInterval: 600 });
  expect(second.connection).toMatchObject({ sessionPresent: false, sessionExpiryInterval: 30 });
  await second.disconnect();
  const third = await client(peer.transport).connect();
  expect(peer.connect(2)).not.toHaveProperty('sessionExpiryInterval');
  expect(third.connection.sessionExpiryInterval).toBe(0);
  await third.disconnect();
});

test.each([
  ['Clean Start true and a successful CONNACK', true, 0, 'Unexpected MQTT Session Present'],
  ['Clean Start false and a refused CONNACK', false, 0x87, 'Invalid CONNACK'],
])('rejects Session Present true after %s', async (_name, cleanStart, reasonCode, message) => {
  const factory = createTransportClient(
    {
      name: 'Raw broker',
      async open(inbound: Readonly<ByteInbound>) {
        return Promise.resolve({
          bufferedBytes: 0,
          async write() {
            await Promise.resolve();
            inbound.bytes(Uint8Array.of(0x20, 3, 1, reasonCode, 0));
          },
          async close() {},
        });
      },
    },
    { clientId: 'resume', cleanStart, sessionState: createSessionState() },
  );
  await expect(factory.connect()).rejects.toMatchObject({ message });
});

test.each([
  ['a cleanStart that is not a boolean', { cleanStart: 'no' }, 'MQTT cleanStart must be a boolean'],
  [
    'a negative sessionExpiryInterval',
    { sessionExpiryInterval: -1 },
    'MQTT sessionExpiryInterval must be an integer from 0 to 4294967295',
  ],
  [
    'a fractional sessionExpiryInterval',
    { sessionExpiryInterval: 1.5 },
    'MQTT sessionExpiryInterval must be an integer from 0 to 4294967295',
  ],
  [
    'a sessionExpiryInterval over 32 bits',
    { sessionExpiryInterval: 2 ** 32 },
    'MQTT sessionExpiryInterval must be an integer from 0 to 4294967295',
  ],
  ['a sessionState from elsewhere', { sessionState: { inFlight: [] } }, 'MQTT sessionState must come from createSessionState()'],
  ['Clean Start false without a sessionState', { cleanStart: false }, 'MQTT cleanStart false needs a sessionState'],
])('rejects %s before the transport opens', async (_name, invalid: Readonly<Record<string, unknown>>, message) => {
  const peer = broker();
  // The test passes values the types exclude, as a JavaScript caller could.
  const options: unknown = { clientId: 'resume', ...invalid };
  const factory: unknown = Reflect.apply(createTransportClient, undefined, [peer.transport, options]);
  if (typeof factory !== 'object' || factory === null || !('connect' in factory) || typeof factory.connect !== 'function')
    throw new Error('Expected a factory');
  const connecting: unknown = Reflect.apply(factory.connect, factory, []);
  await expect(connecting).rejects.toMatchObject({ code: 'ERR_MQTT_INVALID_ARGUMENT', fatal: false, message });
  expect(peer.connections).toHaveLength(0);
});

test('one session state serves one connection at a time, and a second one opens no transport', async () => {
  const peer = broker();
  const sessionState = createSessionState();
  const first = await client(peer.transport, { sessionState }).connect();
  await expect(client(peer.transport, { sessionState }).connect()).rejects.toMatchObject({
    code: 'ERR_MQTT_INVALID_ARGUMENT',
    message: 'MQTT session state is in use by another connection',
  });
  expect(peer.connections).toHaveLength(1);
  await first.disconnect();
  const third = await client(peer.transport, { sessionState }).connect();
  await third.disconnect();
});

test('a resumed session sends the stored publications again with DUP and their identifiers, in order, before new ones', async () => {
  const peer = broker({
    puback: (index) => index !== 1,
    connack: (index) => (index === 1 ? { receiveMaximum: 3 } : { sessionPresent: true, receiveMaximum: 1 }),
  });
  const sessionState = createSessionState();
  const options = { cleanStart: false, sessionExpiryInterval: 600, sessionState };
  const first = await client(peer.transport, options).connect();
  const lost = ['a', 'b', 'c'].map(async (topic) => first.publish(topic, topic, { qos: 1 }));
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  for (const publication of lost) await expect(publication).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  expect(sessionState.inFlight).toEqual([
    { topic: 'a', messageId: 1, qos: 1, acknowledged: false },
    { topic: 'b', messageId: 2, qos: 1, acknowledged: false },
    { topic: 'c', messageId: 3, qos: 1, acknowledged: false },
  ]);

  const second = await client(peer.transport, options).connect();
  const fresh = second.publish('d', 'd', { qos: 1 });
  await second.subscribe('x');
  expect(peer.subscribed(1)).toEqual([4]);
  await expect(fresh).resolves.toBeUndefined();
  // With Receive Maximum 1, each resend waits for the PUBACK of the one before, and the new publication waits for all.
  expect(peer.sent(1)).toEqual([
    ['a', 1, true],
    ['b', 2, true],
    ['c', 3, true],
    ['d', 5, false],
  ]);
  expect(peer.publishes(1)[0]?.payload).toEqual(new TextEncoder().encode('a'));
  expect(sessionState.inFlight).toEqual([]);
  await second.disconnect();
});

test('the stored payload is a copy, so a caller may reuse its bytes once the publish rejects', async () => {
  const peer = broker({ puback: (index) => index !== 1, connack: (index) => ({ sessionPresent: index !== 1 }) });
  const sessionState = createSessionState();
  const options = { cleanStart: false, sessionExpiryInterval: 600, sessionState };
  const first = await client(peer.transport, options).connect();
  const payload = Uint8Array.of(1, 2, 3);
  const correlationData = Uint8Array.of(9);
  const lost = first.publish('bytes', payload, { qos: 1, correlationData });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  payload.fill(0);
  correlationData.fill(0);
  const second = await client(peer.transport, options).connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(peer.publishes(1)).toMatchObject([
    { topic: 'bytes', messageId: 1, dup: true, payload: Uint8Array.of(1, 2, 3), correlationData: Uint8Array.of(9) },
  ]);
  await second.disconnect();
});

test('Session Present false drops the stored publications without sending them', async () => {
  const peer = broker({ puback: (index) => index !== 1 });
  const sessionState = createSessionState();
  const options = { cleanStart: false, sessionExpiryInterval: 600, sessionState };
  const first = await client(peer.transport, options).connect();
  const lost = first.publish('a', 'a', { qos: 1 });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  const second = await client(peer.transport, options).connect();
  expect(second.connection.sessionPresent).toBe(false);
  expect(sessionState.inFlight).toEqual([]);
  await second.publish('b', 'b', { qos: 1 });
  expect(peer.sent(1)).toEqual([['b', 1, false]]);
  await second.disconnect();
});

test('Session Present true with an empty session state sends nothing again', async () => {
  const peer = broker({ connack: () => ({ sessionPresent: true }) });
  const session = await client(peer.transport, { cleanStart: false, sessionState: createSessionState() }).connect();
  expect(session.connection.sessionPresent).toBe(true);
  expect(peer.commands(0)).toEqual(['connect']);
  await session.disconnect();
});

test('a stored publication larger than the new Maximum Packet Size ends the connection before any PUBLISH', async () => {
  const peer = broker({
    puback: (index) => index !== 1,
    connack: (index) => (index === 1 ? {} : { sessionPresent: true, maximumPacketSize: index === 2 ? 32 : 1024 }),
  });
  const sessionState = createSessionState();
  const options = { cleanStart: false, sessionExpiryInterval: 600, sessionState };
  const first = await client(peer.transport, options).connect();
  const lost = first.publish('large', 'x'.repeat(64), { qos: 1 });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  await expect(client(peer.transport, options).connect()).rejects.toMatchObject({
    code: 'ERR_MQTT_SESSION_CONFLICT',
    fatal: true,
    reasonCode: 0,
    message: 'Stored MQTT publication exceeds the Maximum Packet Size',
  });
  expect(peer.commands(1)).toEqual(['connect', 'disconnect']);
  expect(peer.connections[1]?.packets[1]).toEqual({ cmd: 'disconnect' });
  expect(sessionState.inFlight).toEqual([{ topic: 'large', messageId: 1, qos: 1, acknowledged: false }]);
  const third = await client(peer.transport, options).connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(peer.sent(2)).toEqual([['large', 1, true]]);
  expect(sessionState.inFlight).toEqual([]);
  await third.disconnect();
});

test('a failed open releases the session state', async () => {
  const sessionState = createSessionState();
  const refused: ByteTransport = {
    name: 'Refusing transport',
    async open() {
      return Promise.reject(new Error('connect ECONNREFUSED'));
    },
  };
  await expect(createTransportClient(refused, { clientId: 'resume', sessionState }).connect()).rejects.toThrow(
    'connect ECONNREFUSED',
  );
  const peer = broker();
  const session = await client(peer.transport, { sessionState }).connect();
  await session.disconnect();
});

test('a retained stored publication conflicts after CONNACK Retain Available 0', async () => {
  const peer = broker({
    puback: (index) => index !== 1,
    connack: (index) => (index === 1 ? {} : { sessionPresent: true, retainAvailable: index !== 2 }),
  });
  const sessionState = createSessionState();
  const options = { cleanStart: false, sessionExpiryInterval: 600, sessionState };
  const first = await client(peer.transport, options).connect();
  const lost = first.publish('kept', 'k', { qos: 1, retain: true });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  await expect(client(peer.transport, options).connect()).rejects.toMatchObject({
    code: 'ERR_MQTT_SESSION_CONFLICT',
    reasonCode: 0,
    message: 'Stored MQTT publication is retained, and the broker no longer allows retained messages',
  });
  expect(peer.commands(1)).toEqual(['connect', 'disconnect']);
  const third = await client(peer.transport, options).connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(peer.publishes(2)).toMatchObject([{ topic: 'kept', messageId: 1, dup: true, retain: true }]);
  await third.disconnect();
});

const budgetConflict = {
  code: 'ERR_MQTT_SESSION_CONFLICT',
  fatal: true,
  reasonCode: 0,
  message: 'Stored MQTT publication does not fit the write budget',
  cause: { message: 'Session broker write budget exceeded' },
};

test('a resend that the write budget refuses ends the connection with a conflict and stays stored', async () => {
  const peer = broker({ puback: (index) => index === 3, connack: (index) => ({ sessionPresent: index !== 1 }) });
  const sessionState = createSessionState();
  const options = { cleanStart: false, sessionExpiryInterval: 600, sessionState };
  const first = await client(peer.transport, options).connect();
  const lost = first.publish('a', new Uint8Array(1000), { qos: 1 });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  const ends: unknown[] = [];
  const second = await createTransportClient(peer.transport, {
    clientId: 'resume',
    onQosOneMessage() {},
    ...options,
    maxBufferedBytes: 600,
    reservedControlBytes: 0,
    onSessionEnd(end) {
      ends.push(end);
    },
  }).connect();
  await vi.advanceTimersByTimeAsync(0);
  await expect(second.publish('b', 'b', { qos: 1 })).rejects.toMatchObject(budgetConflict);
  expect(peer.commands(1)).toEqual(['connect', 'disconnect']);
  expect(ends).toMatchObject([{ kind: 'error', error: budgetConflict, uncertain: [{ topic: 'a', messageId: 1 }] }]);
  expect(sessionState.inFlight).toEqual([{ topic: 'a', messageId: 1, qos: 1, acknowledged: false }]);
  const third = await client(peer.transport, options).connect();
  await third.publish('c', 'c', { qos: 1 });
  expect(peer.sent(2)).toEqual([
    ['a', 1, true],
    ['c', 2, false],
  ]);
  expect(sessionState.inFlight).toEqual([]);
  await third.disconnect();
});

test('resends wait for the earlier resend writes, so a writer that drains on settle takes all of them', async () => {
  const peer = broker({
    puback: (index) => index !== 1,
    connack: (index) => ({ sessionPresent: index !== 1 }),
    buffered: (index, _written, pending) => (index === 2 ? pending : 0),
  });
  const sessionState = createSessionState();
  const options = { cleanStart: false, sessionExpiryInterval: 600, sessionState };
  const first = await client(peer.transport, options).connect();
  const lost: Promise<unknown>[] = [];
  for (const topic of ['a', 'b', 'c']) {
    lost.push(first.publish(topic, new Uint8Array(300_000), { qos: 1 }).catch((reason: unknown) => reason));
    await vi.advanceTimersByTimeAsync(0);
  }
  peer.connections[0]?.end();
  await Promise.all(lost);
  expect(sessionState.inFlight).toHaveLength(3);
  // Three 300,000-byte resends written back to back would exceed this 700,000-byte budget.
  const second = await createTransportClient(peer.transport, {
    clientId: 'resume',
    onQosOneMessage() {},
    ...options,
    maxBufferedBytes: 700_000,
    reservedControlBytes: 0,
  }).connect();
  await second.publish('d', 'd', { qos: 1 });
  expect(peer.sent(1)).toEqual([
    ['a', 1, true],
    ['b', 2, true],
    ['c', 3, true],
    ['d', 1, false],
  ]);
  expect(sessionState.inFlight).toEqual([]);
  await second.disconnect();
});

test('a resend refused by a writer that never drains ends with a conflict before a new publication takes its identifier', async () => {
  const peer = broker({
    puback: () => false,
    connack: (index) => ({ sessionPresent: index !== 1 }),
    buffered: (index, written) => (index === 2 ? written : 0),
  });
  const sessionState = createSessionState();
  const options = { cleanStart: false, sessionExpiryInterval: 600, sessionState };
  const first = await client(peer.transport, options).connect();
  const lost = ['a', 'b', 'c'].map(async (topic) => first.publish(topic, new Uint8Array(320_000), { qos: 1 }));
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  for (const publication of lost) await expect(publication).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  const second = await client(peer.transport, options).connect();
  await vi.advanceTimersByTimeAsync(0);
  await expect(second.publish('d', 'd', { qos: 1 })).rejects.toMatchObject(budgetConflict);
  expect(peer.sent(1)).toEqual([
    ['a', 1, true],
    ['b', 2, true],
  ]);
  expect(sessionState.inFlight).toEqual([
    { topic: 'a', messageId: 1, qos: 1, acknowledged: false },
    { topic: 'b', messageId: 2, qos: 1, acknowledged: false },
    { topic: 'c', messageId: 3, qos: 1, acknowledged: false },
  ]);
});

test('the reconnecting client retries a budget conflict, sends the earlier resends again on each attempt, and stops', async () => {
  const peer = broker({
    puback: () => false,
    connack: (index) => ({ sessionPresent: index !== 1 }),
    buffered: (index, written) => (index === 1 ? 0 : written),
  });
  const { client: reconnecting, events } = supervise(peer.transport, { maxAttempts: 3, subscriptions: [] });
  const first = await reconnecting.session();
  for (const topic of ['a', 'b', 'c']) {
    first.publish(topic, new Uint8Array(320_000), { qos: 1 }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
  }
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(5000);
  expect(events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'exhausted', error: budgetConflict });
  expect(peer.connections).toHaveLength(3);
  for (const index of [1, 2]) {
    expect(peer.sent(index)).toEqual([
      ['a', 1, true],
      ['b', 2, true],
    ]);
  }
});

test('a new QoS 1 publication waits in the queue, cancelable and unstored, until every resend was written', async () => {
  let held = false;
  const peer = broker({
    puback: (index) => index !== 1,
    connack: (index) => ({ sessionPresent: index !== 1 }),
    hold: (index, bytes) => {
      if (index !== 2 || bytes < 1000 || held) return false;
      held = true;
      return true;
    },
  });
  const sessionState = createSessionState();
  const options = { cleanStart: false, sessionExpiryInterval: 600, sessionState };
  const first = await client(peer.transport, { ...options, timeoutMs: 200 }).connect();
  for (const topic of ['a', 'b', 'c']) {
    first.publish(topic, new Uint8Array(2000), { qos: 1 }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
  }
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(0);
  const ends: unknown[] = [];
  const second = await createTransportClient(peer.transport, {
    clientId: 'resume',
    onQosOneMessage() {},
    ...options,
    timeoutMs: 200,
    onSessionEnd(end) {
      ends.push(end);
    },
  }).connect();
  const controller = new AbortController();
  const withdrawn = second.publish('n', 'n', { qos: 1, signal: controller.signal });
  // The publication rejects while the timers advance, so the handler is attached at once.
  const waiting = second.publish('m', 'm', { qos: 1 }).catch((reason: unknown) => reason);
  controller.abort('stop');
  await expect(withdrawn).rejects.toBe('stop');
  await vi.advanceTimersByTimeAsync(200);
  expect(await waiting).toMatchObject({ code: 'ERR_MQTT_TIMEOUT' });
  expect(peer.commands(1)).toEqual(['connect']);
  expect(ends).toMatchObject([
    {
      kind: 'error',
      error: { code: 'ERR_MQTT_TIMEOUT' },
      uncertain: [
        { topic: 'a', messageId: 1 },
        { topic: 'b', messageId: 2 },
        { topic: 'c', messageId: 3 },
      ],
    },
  ]);
  expect(sessionState.inFlight.map(({ topic }) => topic)).toEqual(['a', 'b', 'c']);
});

test('a QoS 0 publication waits for the resends, so its write does not share the budget with them', async () => {
  const peer = broker({
    puback: (index) => index !== 1,
    connack: (index) => ({ sessionPresent: index !== 1 }),
    buffered: (index, _written, pending) => (index === 2 ? pending : 0),
  });
  const sessionState = createSessionState();
  const options = { cleanStart: false, sessionExpiryInterval: 600, sessionState };
  const first = await client(peer.transport, options).connect();
  for (const size of [100_000, 500_000]) {
    first.publish(size === 100_000 ? 'a' : 'b', new Uint8Array(size), { qos: 1 }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
  }
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(0);
  expect(sessionState.inFlight).toHaveLength(2);
  const second = await client(peer.transport, options).connect();
  await Promise.all([second.publish('z', new Uint8Array(700_000)), second.publish('n', 'n', { qos: 1 })]);
  expect(peer.sent(1)).toEqual([
    ['a', 1, true],
    ['b', 2, true],
    ['z', undefined, undefined],
    ['n', 3, false],
  ]);
  expect(sessionState.inFlight).toEqual([]);
  await second.disconnect();
});

// Stores three QoS 1 publications through a first connection that gets no PUBACK, then ends it.
async function storeThree(transport: Readonly<ByteTransport>, end: () => void, sessionState: SessionState): Promise<void> {
  const first = await client(transport, { cleanStart: false, sessionExpiryInterval: 600, sessionState }).connect();
  for (const topic of ['a', 'b', 'c']) {
    first.publish(topic, topic, { qos: 1 }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
  }
  end();
  await vi.advanceTimersByTimeAsync(0);
}

test('a QoS 0 publication waits through PUBACK round trips without its write deadline expiring', async () => {
  const peer = broker({
    puback: (index) => index !== 1,
    connack: (index) => (index === 1 ? {} : { sessionPresent: true, receiveMaximum: 1 }),
    pubackDelayMs: () => 150,
  });
  const sessionState = createSessionState();
  await storeThree(
    peer.transport,
    () => {
      peer.connections[0]?.end();
    },
    sessionState,
  );
  const second = await client(peer.transport, {
    cleanStart: false,
    sessionExpiryInterval: 600,
    sessionState,
    timeoutMs: 200,
  }).connect();
  const published = second.publish('z', 'z').catch((reason: unknown) => reason);
  await vi.advanceTimersByTimeAsync(600);
  expect(await published).toBeUndefined();
  expect(peer.sent(1)).toEqual([
    ['a', 1, true],
    ['b', 2, true],
    ['c', 3, true],
    ['z', undefined, undefined],
  ]);
  await second.disconnect();
});

test('disconnect() during the resend phase still writes a QoS 0 publication it accepted before', async () => {
  const peer = broker({
    puback: (index) => index !== 1,
    connack: (index) => (index === 1 ? {} : { sessionPresent: true, receiveMaximum: 1 }),
    pubackDelayMs: () => 150,
  });
  const sessionState = createSessionState();
  await storeThree(
    peer.transport,
    () => {
      peer.connections[0]?.end();
    },
    sessionState,
  );
  const second = await client(peer.transport, { cleanStart: false, sessionExpiryInterval: 600, sessionState }).connect();
  const published = second.publish('z', 'z').catch((reason: unknown) => reason);
  const disconnected = second.disconnect({ drainTimeoutMs: 1000 });
  await vi.advanceTimersByTimeAsync(200);
  await disconnected;
  expect(await published).toBeUndefined();
  expect(peer.commands(1)).toEqual(['connect', 'publish', 'publish', 'disconnect']);
  expect(peer.sent(1)).toEqual([
    ['a', 1, true],
    ['z', undefined, undefined],
  ]);
  expect(sessionState.inFlight.map(({ topic }) => topic)).toEqual(['b', 'c']);
});

test.each([
  ['drain false', { drain: false }],
  ['an expired drain deadline', { drainTimeoutMs: 100 }],
] as const)('after disconnect() with %s, no resend or waiting QoS 0 write follows DISCONNECT', async (_name, disconnect) => {
  let held = 0;
  const peer = broker({
    puback: (index) => index !== 1,
    connack: (index) => ({ sessionPresent: index !== 1 }),
    // DISCONNECT settles after the resends would have, as on a socket that flushes it later.
    settleMs: (index, type) => (index !== 2 ? undefined : type === 14 ? 50 : 10),
    // After CONNECT and the first resend, the second resend write never settles, so a drain waits until its deadline.
    hold: (index, bytes) => index === 2 && 'drainTimeoutMs' in disconnect && bytes > 4 && ++held === 3,
  });
  const sessionState = createSessionState();
  await storeThree(
    peer.transport,
    () => {
      peer.connections[0]?.end();
    },
    sessionState,
  );
  const second = await client(peer.transport, { cleanStart: false, sessionExpiryInterval: 600, sessionState }).connect();
  const published = second.publish('z', 'z').catch((reason: unknown) => reason);
  const disconnected = second.disconnect(disconnect);
  await vi.advanceTimersByTimeAsync(500);
  await disconnected;
  expect(await published).toMatchObject({ code: 'ERR_MQTT_CLOSING' });
  expect(peer.commands(1)).toEqual(['connect', 'publish', 'disconnect']);
  expect(peer.sent(1)).toEqual([['a', 1, true]]);
  expect(sessionState.inFlight.map(({ topic }) => topic)).toEqual(['b', 'c']);
});

test('after the resends, waiting QoS 0 writes go first and queued QoS 1 publications follow in call order', async () => {
  const peer = broker({ puback: (index) => index !== 1, connack: (index) => ({ sessionPresent: index !== 1 }) });
  const sessionState = createSessionState();
  await storeThree(
    peer.transport,
    () => {
      peer.connections[0]?.end();
    },
    sessionState,
  );
  const second = await client(peer.transport, { cleanStart: false, sessionExpiryInterval: 600, sessionState }).connect();
  await Promise.all([
    second.publish('A', 'x', { qos: 1 }),
    second.publish('B', 'x'),
    second.publish('C', 'x', { qos: 1 }),
    second.publish('D', 'x'),
  ]);
  const topics: string[] = [];
  for (const [topic] of peer.sent(1)) topics.push(topic);
  expect(topics).toEqual(['a', 'b', 'c', 'B', 'D', 'A', 'C']);
  await second.disconnect();
});

test('the store refuses a new publication whose Packet Identifier a stored publication holds', () => {
  const binding = bindSessionState();
  const stored = { topic: 'a', payload: Uint8Array.of(1), payloadBytes: 1, retain: false, properties: undefined, propertyBytes: 1 };
  binding.record(stored, 1);
  expect(() => {
    binding.record({ ...stored, topic: 'b' }, 1);
  }).toThrow('MQTT session state already stores Packet Identifier 1');
  expect(binding.state.inFlight).toEqual([{ topic: 'a', messageId: 1, qos: 1, acknowledged: false }]);
});

test('a resumed session whose broker no longer allows QoS 1 ends before any PUBLISH', async () => {
  const peer = broker({
    puback: (index) => index !== 1,
    connack: (index) => (index === 1 ? {} : { sessionPresent: true, maximumQoS: 0 }),
  });
  const sessionState = createSessionState();
  const options = { cleanStart: false, sessionExpiryInterval: 600, sessionState };
  const first = await client(peer.transport, options).connect();
  const lost = first.publish('a', 'a', { qos: 1 });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  await expect(client(peer.transport, options).connect()).rejects.toMatchObject({ code: 'ERR_MQTT_SESSION_CONFLICT' });
  expect(peer.commands(1)).toEqual(['connect', 'disconnect']);
  expect(sessionState.inFlight).toHaveLength(1);
});

interface Supervised {
  readonly events: ReconnectEvent[];
  readonly messages: { topic: string; dup: boolean }[];
  readonly client: ReturnType<typeof createReconnectingClient>;
}

function supervise(
  transport: Readonly<ByteTransport>,
  reconnect: Readonly<ReconnectOptions> = {},
  factory: Readonly<{ sessionExpiryInterval?: number }> = { sessionExpiryInterval: 600 },
): Supervised {
  const events: ReconnectEvent[] = [];
  const messages: { topic: string; dup: boolean }[] = [];
  const reconnecting = createReconnectingClient<ByteClientOptions>(
    (options: ReadonlyDeep<ByteClientOptions>) => createTransportClient(transport, options),
    {
      clientId: 'resume',
      onQosOneMessage(message: ReadonlyDeep<QosOneMessage<PublishMessage>>) {
        messages.push({ topic: message.topic, dup: message.dup });
      },
      ...factory,
    },
    {
      random: () => 0,
      resume: true,
      subscriptions: [{ topic: 'commands/#', qos: 1 }],
      ...reconnect,
      async onReconnect(event) {
        events.push(event);
        await reconnect.onReconnect?.(event);
      },
    },
  );
  return { events, messages, client: reconnecting };
}

test('the reconnecting client resumes the session, keeps the subscriptions and reports the resent PUBACK', async () => {
  const peer = broker({ puback: (index) => index !== 1, connack: (index) => ({ sessionPresent: index !== 1 }) });
  const { client: reconnecting, events } = supervise(peer.transport);
  const first = await reconnecting.session();
  expect(peer.connect(0)).toMatchObject({ cleanStart: true, sessionExpiryInterval: 600 });
  expect(peer.commands(0)).toEqual(['connect', 'subscribe']);
  const lost = first.publish('sensor/1', 'reading', { qos: 1 });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  await vi.advanceTimersByTimeAsync(500);
  await reconnecting.session();
  expect(peer.connect(1)).toMatchObject({ cleanStart: false, sessionExpiryInterval: 600 });
  expect(peer.sent(1)).toEqual([['sensor/1', 2, true]]);
  expect(peer.commands(1)).toEqual(['connect', 'publish']);
  const uncertain = [{ topic: 'sensor/1', messageId: 2, qos: 1, acknowledged: false }];
  expect(events.slice(1)).toMatchObject([
    { kind: 'retrying', attempt: 2 },
    {
      kind: 'connected',
      generation: 2,
      resumed: true,
      subscriptions: [],
      resent: uncertain,
      previous: { kind: 'error', uncertain },
    },
    { kind: 'puback', topic: 'sensor/1', messageId: 2, reasonCode: 0 },
  ]);
  expect(events[0]).toMatchObject({ kind: 'connected', resumed: false });
  expect(events[2]).not.toHaveProperty('dropped');
  await reconnecting.disconnect();
});

test('the reconnecting client makes the subscriptions again and reports dropped publications after Session Present false', async () => {
  const peer = broker({ puback: (index) => index !== 1 });
  const { client: reconnecting, events } = supervise(peer.transport);
  const first = await reconnecting.session();
  const lost = first.publish('sensor/1', 'reading', { qos: 1 });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  await vi.advanceTimersByTimeAsync(500);
  await reconnecting.session();
  expect(peer.connect(1)).toMatchObject({ cleanStart: false });
  expect(peer.commands(1)).toEqual(['connect', 'subscribe']);
  expect(events.at(-1)).toMatchObject({
    kind: 'connected',
    resumed: false,
    subscriptions: [{ topic: 'commands/#', qos: 1, result: { reasonCode: 0 } }],
    dropped: [{ topic: 'sensor/1', messageId: 2, qos: 1, acknowledged: false }],
  });
  expect(events.at(-1)).not.toHaveProperty('resent');
  await reconnecting.disconnect();
});

test('a packet limit conflict retries within maxAttempts, keeps the publication and never sends it oversized or renumbered', async () => {
  const peer = broker({
    puback: (index) => index !== 1,
    connack: (index) => (index === 1 ? {} : { sessionPresent: true, maximumPacketSize: 32 }),
  });
  const { client: reconnecting, events } = supervise(peer.transport, { maxAttempts: 3 });
  const first = await reconnecting.session();
  const lost = first.publish('large', 'x'.repeat(64), { qos: 1 });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  await vi.advanceTimersByTimeAsync(5000);
  expect(events.map((event) => event.kind)).toEqual(['connected', 'retrying', 'retrying', 'stopped']);
  expect(events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'exhausted', error: { code: 'ERR_MQTT_SESSION_CONFLICT' } });
  expect(events[2]).toMatchObject({ kind: 'retrying', attempt: 3, error: { code: 'ERR_MQTT_SESSION_CONFLICT' } });
  expect(peer.connections).toHaveLength(3);
  for (const index of [1, 2]) expect(peer.commands(index)).toEqual(['connect', 'disconnect']);
});

test('resetSession() after a packet limit conflict starts a clean session and reports the publication as dropped', async () => {
  const peer = broker({
    puback: (index) => index !== 1,
    connack: (index) =>
      index === 2 ? { sessionPresent: true, maximumPacketSize: 32 } : { maximumPacketSize: index === 1 ? 1024 : 32 },
  });
  const { client: reconnecting, events } = supervise(peer.transport, {
    onReconnect(event) {
      if (event.kind === 'retrying' && event.error instanceof Error && 'code' in event.error) {
        if (event.error.code === 'ERR_MQTT_SESSION_CONFLICT') reconnecting.resetSession();
      }
    },
  });
  const first = await reconnecting.session();
  const lost = first.publish('large', 'x'.repeat(64), { qos: 1 });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  await vi.advanceTimersByTimeAsync(1500);
  const third = await reconnecting.session();
  expect(peer.connect(2)).toMatchObject({ cleanStart: true });
  expect(peer.commands(2)).toEqual(['connect', 'subscribe']);
  expect(events.at(-1)).toMatchObject({
    kind: 'connected',
    generation: 2,
    resumed: false,
    dropped: [{ topic: 'large', messageId: 2, qos: 1, acknowledged: false }],
  });
  await third.publish('small', 's', { qos: 1 });
  for (const index of [1, 2]) {
    for (const bytes of peer.connections[index]?.publishBytes ?? []) expect(bytes).toBeLessThanOrEqual(32);
    for (const [topic] of peer.sent(index)) expect(topic).not.toBe('large');
  }
  expect(peer.sent(2)).toEqual([['small', 2, false]]);
  await reconnecting.disconnect();
});

test('a redelivered inbound QoS 1 message after a resume reaches the handler and is acknowledged', async () => {
  const peer = broker({ connack: (index) => ({ sessionPresent: index !== 1 }) });
  const { client: reconnecting, messages } = supervise(peer.transport);
  await reconnecting.session();
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(500);
  await reconnecting.session();
  peer.connections[1]?.deliver({ cmd: 'publish', topic: 'commands/1', payload: Uint8Array.of(1), qos: 1, messageId: 9, dup: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(messages).toEqual([{ topic: 'commands/1', dup: true }]);
  expect(peer.connections[1]?.packets.at(-1)).toEqual({ cmd: 'puback', messageId: 9, reasonCode: 0 });
  await reconnecting.disconnect();
});

test('a Topic Alias after a resume is still a protocol error, because the client allows no aliases', async () => {
  const peer = broker({ connack: (index) => ({ sessionPresent: index !== 1, topicAliasMaximum: 10 }) });
  const { client: reconnecting, events } = supervise(peer.transport);
  await reconnecting.session();
  expect(peer.connect(0)).not.toHaveProperty('topicAliasMaximum');
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(500);
  const resumed = await reconnecting.session();
  expect(resumed.connection.sessionPresent).toBe(true);
  // A QoS 0 PUBLISH with an empty topic, Topic Alias 1 and the payload "x".
  peer.connections[1]?.deliverBytes([0x30, 7, 0, 0, 3, 0x23, 0, 1, 0x78]);
  await vi.advanceTimersByTimeAsync(0);
  expect(peer.connections[1]?.packets.at(-1)).toEqual({ cmd: 'disconnect', reasonCode: 0x94 });
  expect(events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'fatal', error: { code: 'ERR_MQTT_PROTOCOL', reasonCode: 0x94 } });
});

test('resume needs a Session Expiry Interval above 0', () => {
  const peer = broker();
  expect(() => supervise(peer.transport, {}, {})).toThrow(RangeError);
  expect(() => supervise(peer.transport, {}, { sessionExpiryInterval: 0 })).toThrow(RangeError);
  expect(() => supervise(peer.transport, {}, { sessionExpiryInterval: 2 ** 32 })).toThrow(RangeError);
  expect(peer.connections).toHaveLength(0);
});

test('without resume, resetSession() changes nothing and every attempt sends the factory Clean Start flag', async () => {
  const peer = broker();
  const { client: reconnecting } = supervise(peer.transport, { resume: false }, { sessionExpiryInterval: 600 });
  await reconnecting.session();
  reconnecting.resetSession();
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(500);
  await reconnecting.session();
  expect(peer.connect(1)).toMatchObject({ cleanStart: true });
  expect(peer.commands(1)).toEqual(['connect', 'subscribe']);
  await reconnecting.disconnect();
});
