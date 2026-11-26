import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ByteInbound, ByteTransport } from '../src/byteTransport.js';
import { encodePacket, PacketDecoder, type BrokerPacket, type ClientPacket } from '../src/codec.js';
import { MqttError } from '../src/mqttError.js';
import { createTransportClient } from '../src/portableClient.js';
import { createReconnectingClient, type ReconnectEvent, type ReconnectOptions } from '../src/reconnect.js';

interface Connection {
  readonly packets: ClientPacket[];
  /** Sends a broker packet on this connection at once, even after it ended. */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- encodePacket in src/wireCodec.ts takes the codec's BrokerPacket, whose PUBLISH payload is a native Uint8Array.
  deliver(packet: BrokerPacket): void;
  end(): void;
}

interface Script {
  /** The CONNACK reason for the nth connection, starting at 1. Undefined withholds the CONNACK. */
  connack?: (connection: number) => number | undefined;
  /** The SUBACK reason for a filter. Defaults to 0. */
  suback?: (topic: string) => number;
  /** Whether to answer a QoS 1 PUBLISH with PUBACK. */
  puback?: boolean;
  /** The PUBACK reason. Defaults to 0. */
  pubackCode?: number;
  /** Sends the PUBACK for a QoS 1 PUBLISH and never settles the write of that PUBLISH. */
  holdPublishWrite?: boolean;
  /** Rejects every open with ECONNREFUSED. */
  refuse?: boolean;
  receiveMaximum?: number;
}

// A broker over the byte transport. It answers CONNECT, SUBSCRIBE and QoS 1 PUBLISH, and records every packet it reads.
function broker(script: Readonly<Script> = {}) {
  const connections: Connection[] = [];
  const transport: ByteTransport = {
    name: 'Scripted broker',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- ByteTransport.open in src/byteTransport.ts takes the mutable ByteInbound and returns a promise, and promise-function-async requires an async function for that. This opener settles without waiting for anything.
    async open(inbound: ByteInbound) {
      const decoder = new PacketDecoder();
      const index = connections.length + 1;
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- encodePacket in src/wireCodec.ts takes the codec's BrokerPacket, whose PUBLISH payload is a native Uint8Array.
      const deliver = (packet: BrokerPacket): void => {
        inbound.bytes(encodePacket(packet));
      };
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- deliver takes the codec's BrokerPacket for encodePacket in src/wireCodec.ts, whose PUBLISH payload is a native Uint8Array.
      const reply = (packet: BrokerPacket): void => {
        // Deliver after the write that caused the reply has returned, as a socket would.
        queueMicrotask(() => {
          deliver(packet);
        });
      };
      const connection: Connection = {
        packets: [],
        deliver,
        end() {
          inbound.end();
        },
      };
      connections.push(connection);
      if (script.refuse === true) throw new MqttError('ERR_MQTT_TRANSPORT', 'connect ECONNREFUSED');
      return {
        bufferedBytes: 0,
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteWriter.write in src/byteTransport.ts takes the encoded Uint8Array by identity.
        async write(bytes: Uint8Array) {
          for (const packet of decoder.push(bytes)) {
            if (packet.cmd === 'connack' || packet.cmd === 'suback' || packet.cmd === 'unsuback' || packet.cmd === 'pingresp')
              continue;
            connection.packets.push(packet);
            if (packet.cmd === 'connect') {
              const reasonCode = script.connack === undefined ? 0 : script.connack(index);
              if (reasonCode !== undefined)
                reply({
                  cmd: 'connack',
                  sessionPresent: false,
                  reasonCode,
                  ...(script.receiveMaximum === undefined ? {} : { receiveMaximum: script.receiveMaximum }),
                });
            } else if (packet.cmd === 'subscribe') {
              const [topic = ''] = packet.topics;
              reply({ cmd: 'suback', messageId: packet.messageId, granted: [script.suback?.(topic) ?? 0] });
            } else if (packet.cmd === 'pingreq') {
              reply({ cmd: 'pingresp' });
            } else if (packet.cmd === 'publish' && packet.qos === 1 && script.puback !== false) {
              reply({ cmd: 'puback', messageId: packet.messageId, reasonCode: script.pubackCode ?? 0 });
              if (script.holdPublishWrite === true) await new Promise<void>(() => {});
            }
          }
        },
        async close() {},
      };
    },
  };
  /** The commands, and the filters of each SUBSCRIBE, that the broker read on the nth connection, counted from 0. */
  const received = (index: number): { commands: string[]; topics: string[] } => {
    const commands: string[] = [];
    const topics: string[] = [];
    for (const packet of connections[index]?.packets ?? []) {
      commands.push(packet.cmd);
      if (packet.cmd === 'subscribe') topics.push(...packet.topics);
    }
    return { commands, topics };
  };
  return { transport, connections, received };
}

interface FactoryOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxPacketBytes?: number;
}

function reconnecting(
  transport: Readonly<ByteTransport>,
  reconnect: Readonly<ReconnectOptions> = {},
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- FactoryOptions holds a native AbortSignal, which ByteClientOptions in src/transportCore.ts takes by identity.
  factory: FactoryOptions = {},
) {
  const events: ReconnectEvent[] = [];
  const client = createReconnectingClient(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteClientOptions in src/transportCore.ts holds a native AbortSignal and Uint8Array callbacks, which createTransportClient keeps by identity.
    (options) => createTransportClient(transport, options),
    { clientId: 'reconnect', onQosOneMessage() {}, ...factory },
    {
      random: () => 0,
      ...reconnect,
      async onReconnect(event) {
        events.push(event);
        await reconnect.onReconnect?.(event);
      },
    },
  );
  return { client, events };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

test('opens a new session after the connection ends, once the jittered delay has passed', async () => {
  const peer = broker();
  const { client, events } = reconnecting(peer.transport);
  const first = await client.session();
  expect(events).toMatchObject([{ kind: 'connected', generation: 1, attempt: 1 }]);
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(0);
  // With random() = 0, the first delay is half of initialDelayMs.
  expect(events[1]).toMatchObject({ kind: 'retrying', attempt: 2, delayMs: 500 });
  await vi.advanceTimersByTimeAsync(499);
  expect(peer.connections).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  const second = await client.session();
  expect(second).not.toBe(first);
  expect(peer.connections[1]?.packets[0]?.cmd).toBe('connect');
  expect(events[2]).toMatchObject({ kind: 'connected', generation: 2, attempt: 2, previous: { kind: 'error' } });
  await client.disconnect();
});

test('returns the same session promise until that session ends', async () => {
  const peer = broker();
  const { client } = reconnecting(peer.transport);
  const pending = client.session();
  expect(client.session()).toBe(pending);
  await pending;
  expect(client.session()).toBe(pending);
  await client.disconnect();
});

test('doubles the delay up to maxDelayMs and spreads it with jitter', async () => {
  const peer = broker({ connack: (connection) => (connection === 1 ? 0 : 0x88) });
  const { client, events } = reconnecting(peer.transport, {
    initialDelayMs: 100,
    maxDelayMs: 300,
    maxAttempts: 5,
    random: () => 0.5,
  });
  await client.session();
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(5000);
  const delays = events.flatMap((event) => (event.kind === 'retrying' ? [event.delayMs] : []));
  // Ceilings of 100, 200, 300 and 300, each spread to three quarters by random() = 0.5.
  expect(delays).toEqual([75, 150, 225, 225]);
  expect(events.at(-1)).toMatchObject({
    kind: 'stopped',
    reason: 'exhausted',
    error: { code: 'ERR_MQTT_REFUSED', reasonCode: 0x88 },
  });
  expect(peer.connections).toHaveLength(5);
});

test('reports an in-flight QoS 1 publication as uncertain and never sends it again', async () => {
  const peer = broker({ puback: false, receiveMaximum: 1 });
  const { client, events } = reconnecting(peer.transport);
  const session = await client.session();
  const inFlight = session.publish('sensor/1', 'in flight', { qos: 1 });
  const queued = session.publish('sensor/2', 'queued', { qos: 1 });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(inFlight).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT', fatal: true });
  await expect(queued).rejects.toMatchObject({ fatal: true });
  await vi.advanceTimersByTimeAsync(500);
  await client.session();
  const connected = events.findLast((event) => event.kind === 'connected');
  expect(connected).toMatchObject({
    generation: 2,
    previous: { kind: 'error', uncertain: [{ topic: 'sensor/1', messageId: 1, acknowledged: false }] },
  });
  expect(peer.received(1).commands).toEqual(['connect']);
  await client.disconnect();
});

test('makes the subscriptions on every connection and reports a refused SUBACK without ending the session', async () => {
  const peer = broker({ suback: (topic) => (topic === 'denied/#' ? 0x87 : topic === 'alerts' ? 1 : 0) });
  const { client, events } = reconnecting(peer.transport, {
    subscriptions: [{ topic: 'sensor/+' }, { topic: 'denied/#' }, { topic: 'alerts', qos: 1 }],
  });
  const session = await client.session();
  expect(events[0]).toMatchObject({
    kind: 'connected',
    subscriptions: [
      { topic: 'sensor/+', qos: 0, result: { reasonCode: 0 } },
      { topic: 'denied/#', qos: 0, error: { code: 'ERR_MQTT_REFUSED', reasonCode: 0x87, fatal: false } },
      { topic: 'alerts', qos: 1, result: { grantedQos: 1 } },
    ],
  });
  await session.ping();
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(500);
  await client.session();
  expect(peer.received(1).topics).toEqual(['sensor/+', 'denied/#', 'alerts']);
  await client.disconnect();
});

test.each([
  ['Not authorized', 0x87, 'refused', 1],
  ['Bad user name or password', 0x86, 'refused', 1],
])('stops after a CONNACK that says %s', async (_name, reasonCode, reason, opens) => {
  const peer = broker({ connack: () => reasonCode });
  const { client, events } = reconnecting(peer.transport);
  await expect(client.session()).rejects.toMatchObject({ code: 'ERR_MQTT_REFUSED', reasonCode });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(peer.connections).toHaveLength(opens);
  expect(events).toMatchObject([{ kind: 'stopped', reason }]);
  expect(vi.getTimerCount()).toBe(0);
});

test('retries after a CONNACK that says Server unavailable', async () => {
  const peer = broker({ connack: (connection) => (connection === 1 ? 0x88 : 0) });
  const { client, events } = reconnecting(peer.transport);
  await vi.advanceTimersByTimeAsync(500);
  await client.session();
  expect(events).toMatchObject([
    { kind: 'retrying', attempt: 2, error: { code: 'ERR_MQTT_REFUSED', reasonCode: 0x88 } },
    { kind: 'connected', generation: 1, attempt: 2 },
  ]);
  expect(events[1]).not.toHaveProperty('previous');
  await client.disconnect();
});

test('disconnect() while connected sends DISCONNECT and leaves no timer', async () => {
  const peer = broker();
  const { client, events } = reconnecting(peer.transport);
  await client.session();
  await client.disconnect();
  expect(peer.connections[0]?.packets.at(-1)?.cmd).toBe('disconnect');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(peer.connections).toHaveLength(1);
  expect(events.at(-1)).toEqual({ kind: 'stopped', reason: 'disconnect' });
  await expect(client.session()).rejects.toMatchObject({ code: 'ERR_MQTT_CLOSING' });
  expect(vi.getTimerCount()).toBe(0);
});

test('disconnect() while waiting clears the retry timer', async () => {
  const peer = broker();
  const { client } = reconnecting(peer.transport);
  await client.session();
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(0);
  const waiting = client.session();
  await client.disconnect();
  await expect(waiting).rejects.toMatchObject({ code: 'ERR_MQTT_CLOSING' });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(peer.connections).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('disconnect() while connecting abandons the attempt', async () => {
  const peer = broker({ connack: () => undefined });
  const { client } = reconnecting(peer.transport);
  await vi.advanceTimersByTimeAsync(0);
  const pending = client.session();
  await client.disconnect();
  await expect(pending).rejects.toMatchObject({ code: 'ERR_MQTT_CLOSING' });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(peer.connections).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('a disconnect() on the session itself stops reconnecting', async () => {
  const peer = broker();
  const { client, events } = reconnecting(peer.transport);
  const session = await client.session();
  await session.disconnect();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(peer.connections).toHaveLength(1);
  expect(events.at(-1)).toEqual({ kind: 'stopped', reason: 'disconnect' });
});

test('an aborted signal stops reconnecting and rejects with its reason', async () => {
  const peer = broker();
  const controller = new AbortController();
  const { client, events } = reconnecting(peer.transport, {}, { signal: controller.signal });
  await client.session();
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(0);
  const reason = new Error('page hidden');
  controller.abort(reason);
  await expect(client.session()).rejects.toBe(reason);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(peer.connections).toHaveLength(1);
  expect(events.at(-1)).toEqual({ kind: 'stopped', reason: 'aborted', error: reason });
  expect(vi.getTimerCount()).toBe(0);
});

test('a session that stays up for stableAfterMs resets the attempt count', async () => {
  const peer = broker();
  const { client, events } = reconnecting(peer.transport, { initialDelayMs: 100, maxDelayMs: 1000, stableAfterMs: 5000 });
  await client.session();
  // A session that ends at once keeps counting, so the second delay doubles.
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(50);
  await client.session();
  peer.connections[1]?.end();
  await vi.advanceTimersByTimeAsync(100);
  await client.session();
  await vi.advanceTimersByTimeAsync(5000);
  peer.connections[2]?.end();
  await vi.advanceTimersByTimeAsync(0);
  const retries = events.flatMap((event) => (event.kind === 'retrying' ? [[event.attempt, event.delayMs]] : []));
  expect(retries).toEqual([
    [2, 50],
    [3, 100],
    [1, 50],
  ]);
  await client.disconnect();
});

test('a ten-minute timer jump starts one attempt and leaves at most one timer', async () => {
  const peer = broker({ connack: (connection) => (connection === 2 ? undefined : 0) });
  // The longest timeout the factory accepts, so the open attempt waits for its CONNACK through both jumps.
  const { client } = reconnecting(peer.transport, {}, { timeoutMs: 2_147_483_647 });
  await client.session();
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  // The jump while waiting fires the retry timer once, and the attempt it opens waits for a CONNACK.
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(peer.connections).toHaveLength(2);
  expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  // The jump while the attempt is open starts no other attempt.
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(peer.connections).toHaveLength(2);
  expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  await client.disconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('rejects invalid reconnect options at once', () => {
  const { transport } = broker();
  expect(() => reconnecting(transport, { initialDelayMs: -1 })).toThrow(RangeError);
  expect(() => reconnecting(transport, { maxDelayMs: Number.NaN })).toThrow(RangeError);
  expect(() => reconnecting(transport, { stableAfterMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  expect(() => reconnecting(transport, { maxAttempts: -1 })).toThrow(RangeError);
  expect(() => reconnecting(transport, { maxAttempts: Number.NaN })).toThrow(RangeError);
});

test('passes the error from a failed connection to the retrying event', async () => {
  const { transport } = broker({ refuse: true });
  const { client, events } = reconnecting(transport, { maxAttempts: 2 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(events).toMatchObject([
    { kind: 'retrying', attempt: 2, error: { message: 'connect ECONNREFUSED' } },
    { kind: 'stopped', reason: 'exhausted' },
  ]);
  await expect(client.session()).rejects.toMatchObject({ message: 'connect ECONNREFUSED' });
});

test('maxAttempts Infinity retries forever', async () => {
  const peer = broker({ refuse: true });
  const { client, events } = reconnecting(peer.transport, {
    initialDelayMs: 10,
    maxDelayMs: 10,
    maxAttempts: Number.POSITIVE_INFINITY,
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(peer.connections.length).toBeGreaterThan(100);
  expect(events.every((event) => event.kind === 'retrying')).toBe(true);
  await client.disconnect();
  expect(vi.getTimerCount()).toBe(0);
});

test('keeps the uncertain publications of the last session through a failed attempt', async () => {
  const peer = broker({ puback: false, connack: (connection) => (connection === 2 ? 0x88 : 0) });
  const { client, events } = reconnecting(peer.transport);
  const session = await client.session();
  const lost = session.publish('sensor/1', 'lost', { qos: 1 });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  // With random() = 0, the second attempt opens after 500 ms and the third 1,000 ms after the refusal.
  await vi.advanceTimersByTimeAsync(1500);
  await client.session();
  expect(events).toMatchObject([
    { kind: 'connected', generation: 1, attempt: 1 },
    { kind: 'retrying', attempt: 2, error: { code: 'ERR_MQTT_TRANSPORT' } },
    { kind: 'retrying', attempt: 3, error: { code: 'ERR_MQTT_REFUSED', reasonCode: 0x88 } },
    {
      kind: 'connected',
      generation: 2,
      attempt: 3,
      previous: {
        kind: 'error',
        error: { code: 'ERR_MQTT_TRANSPORT' },
        uncertain: [{ topic: 'sensor/1', messageId: 1, acknowledged: false }],
      },
    },
  ]);
  await client.disconnect();
});

test.each([
  ['accepted', 0, true],
  ['refused', 0x87, false],
])('reports a PUBACK that %s the publication before its write settled', async (_name, pubackCode, acknowledged) => {
  const peer = broker({ pubackCode, holdPublishWrite: true });
  const { client, events } = reconnecting(peer.transport);
  const session = await client.session();
  const publication = session.publish('sensor/1', 'held', { qos: 1 });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(publication).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  await vi.advanceTimersByTimeAsync(500);
  await client.session();
  expect(events.at(-1)).toMatchObject({
    kind: 'connected',
    previous: { uncertain: [{ topic: 'sensor/1', messageId: 1, acknowledged }] },
  });
  await client.disconnect();
});

test('a PUBACK on the connection of an ended session does not reach the next session', async () => {
  const peer = broker({ puback: false });
  const { client } = reconnecting(peer.transport);
  const first = await client.session();
  const lost = first.publish('sensor/1', 'lost', { qos: 1 });
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  await vi.advanceTimersByTimeAsync(500);
  const second = await client.session();
  const pending = second.publish('sensor/2', 'pending', { qos: 1 });
  const settled = vi.fn<(outcome: unknown) => void>();
  pending.then(settled, settled);
  await vi.advanceTimersByTimeAsync(0);
  // Each session numbers its packets from 1, so the stale PUBACK carries the identifier of the new publication.
  expect(peer.connections[1]?.packets.at(-1)).toMatchObject({ cmd: 'publish', topic: 'sensor/2', messageId: 1 });
  peer.connections[0]?.deliver({ cmd: 'puback', messageId: 1, reasonCode: 0 });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).not.toHaveBeenCalled();
  peer.connections[1]?.deliver({ cmd: 'puback', messageId: 1, reasonCode: 0 });
  await expect(pending).resolves.toBeUndefined();
  await client.disconnect();
});

test('disconnect() from the retrying callback leaves no timer', async () => {
  const peer = broker();
  const { client, events } = reconnecting(peer.transport, {
    async onReconnect(event) {
      if (event.kind === 'retrying') await client.disconnect();
    },
  });
  await client.session();
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(0);
  expect(events.map((event) => event.kind)).toEqual(['connected', 'retrying', 'stopped']);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(peer.connections).toHaveLength(1);
});

test('an abort reason that is not an Error stops the client with an AbortError', async () => {
  const peer = broker();
  const controller = new AbortController();
  const { client, events } = reconnecting(peer.transport, {}, { signal: controller.signal });
  await client.session();
  controller.abort('page hidden');
  const expected = { name: 'AbortError', code: 'ERR_MQTT_ABORTED', cause: 'page hidden' };
  await expect(client.session()).rejects.toMatchObject(expected);
  await expect(client.session()).rejects.toBeInstanceOf(MqttError);
  expect(events.at(-1)).toMatchObject({ kind: 'stopped', reason: 'aborted', error: expected });
});

test('a value that create throws stops the client with ERR_MQTT_TRANSPORT', async () => {
  const events: ReconnectEvent[] = [];
  const thrown: unknown = 'no factory';
  const client = createReconnectingClient(
    () => {
      throw thrown;
    },
    {},
    {
      onReconnect(event) {
        events.push(event);
      },
    },
  );
  const expected = { name: 'MqttError', code: 'ERR_MQTT_TRANSPORT', fatal: true, cause: 'no factory' };
  await expect(client.session()).rejects.toMatchObject(expected);
  expect(events).toMatchObject([{ kind: 'stopped', reason: 'fatal', error: expected }]);
});

test('an invalid factory option stops the client before it opens a connection', async () => {
  const peer = broker();
  const { client, events } = reconnecting(peer.transport, {}, { timeoutMs: 0 });
  await expect(client.session()).rejects.toBeInstanceOf(RangeError);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(peer.connections).toHaveLength(0);
  expect(events).toMatchObject([{ kind: 'stopped', reason: 'fatal' }]);
  expect(vi.getTimerCount()).toBe(0);
});

test('retries after a broker packet over maxPacketBytes', async () => {
  const peer = broker();
  const { client, events } = reconnecting(peer.transport, {}, { maxPacketBytes: 64 });
  await client.session();
  peer.connections[0]?.deliver({ cmd: 'publish', topic: 'large', payload: new Uint8Array(100), qos: 0, retain: false });
  await vi.advanceTimersByTimeAsync(0);
  const retrying = events[1];
  expect(retrying).toMatchObject({ kind: 'retrying', attempt: 2, error: { message: 'MQTT packet allocation limit exceeded' } });
  expect(retrying?.kind === 'retrying' ? retrying.error : undefined).toBeInstanceOf(RangeError);
  await vi.advanceTimersByTimeAsync(500);
  await client.session();
  expect(events.at(-1)).toMatchObject({ kind: 'connected', generation: 2 });
  await client.disconnect();
});
