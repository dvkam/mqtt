import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ByteTransport } from '../src/byteTransport.js';
import {
  createSessionState,
  createTransportClient,
  type ByteClientOptions,
  type SessionEnd,
  type SessionState,
} from '../src/portableClient.js';
import { createReconnectingClient, type ReconnectEvent } from '../src/reconnect.js';
import { acknowledge, exchangeBroker, settle, type Delivery, type ExchangeConnection } from './experiments/exchange-broker.js';

const qosTwo = { qos: 2 } as const;
const qosOne = { qos: 1 } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

type Options = Readonly<Pick<ByteClientOptions, 'cleanStart' | 'onQosOneMessage' | 'onQosTwoMessage'>>;

function connect(transport: Readonly<ByteTransport>, sessionState: SessionState, options: Options = {}) {
  const ends: SessionEnd[] = [];
  const connecting = createTransportClient(transport, {
    clientId: 'resume',
    sessionExpiryInterval: 60,
    sessionState,
    onSessionEnd(event) {
      ends.push(event);
    },
    ...options,
  }).connect();
  return { connecting, ends };
}

/** End the connection and wait for the publish promises to reject. */
async function lose(
  connection: Readonly<Pick<ExchangeConnection, 'end'>>,
  publications: readonly Readonly<Promise<unknown>>[],
): Promise<void> {
  connection.end();
  await Promise.allSettled(publications);
  await settle();
}

function pubrec(messageId: number, reasonCode = 0): Delivery {
  return { cmd: 'pubrec', messageId, reasonCode };
}

test('a resumed session sends a QoS 2 PUBLISH without PUBREC again with DUP and its Packet Identifier', async () => {
  const peer = exchangeBroker({
    connack: (index) => ({ sessionPresent: index === 2 }),
    answer: (packet, index) => (index === 1 ? undefined : acknowledge(packet)),
  });
  const sessionState = createSessionState();
  const first = await connect(peer.transport, sessionState).connecting;
  const lost = first.publish('a', 'hi', qosTwo);
  await settle();
  expect(sessionState.inFlight).toEqual([{ topic: 'a', messageId: 1, qos: 2, acknowledged: false }]);
  await lose(peer.connection(0), [lost]);
  await expect(lost).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
  const second = await connect(peer.transport, sessionState, { cleanStart: false }).connecting;
  await settle();
  expect(peer.connection(1).frames).toEqual([
    [0x3c, 8, 0, 1, 0x61, 0, 1, 0, 0x68, 0x69],
    [0x62, 2, 0, 1],
  ]);
  expect(sessionState.inFlight).toEqual([]);
  await second.disconnect();
});

test('a resumed session sends only PUBREL for a QoS 2 publication that has its PUBREC', async () => {
  const peer = exchangeBroker({
    connack: (index) => ({ sessionPresent: index === 2 }),
    answer: (packet) => (packet.cmd === 'pubrel' && packet.messageId === 1 ? undefined : acknowledge(packet)),
  });
  const sessionState = createSessionState();
  const { connecting, ends } = connect(peer.transport, sessionState);
  const first = await connecting;
  const lost = first.publish('a', 'hi', qosTwo);
  await settle();
  expect(peer.sent(0)).toEqual(['publish a qos 2 id 1', 'pubrel 1']);
  const uncertain = [{ topic: 'a', messageId: 1, qos: 2, acknowledged: true }];
  expect(sessionState.inFlight).toEqual(uncertain);
  await lose(peer.connection(0), [lost]);
  expect(ends).toMatchObject([{ kind: 'error', uncertain }]);
  const second = await connect(peer.transport, sessionState, { cleanStart: false }).connecting;
  await settle();
  expect(peer.connection(1).frames).toEqual([[0x62, 2, 0, 1]]);
  expect(sessionState.inFlight).toEqual(uncertain);
  // The unfinished exchange keeps Packet Identifier 1, so a new publication takes the next one.
  await second.publish('b', 'next', qosTwo);
  expect(peer.sent(1)).toEqual(['pubrel 1', 'publish b qos 2 id 2', 'pubrel 2']);
  peer.connection(1).deliver({ cmd: 'pubcomp', messageId: 1, reasonCode: 0 });
  await settle();
  expect(sessionState.inFlight).toEqual([]);
  await second.disconnect();
});

test('a resumed session sends PUBREL in PUBREC order, then each PUBLISH in its first order, within the Receive Maximum', async () => {
  const peer = exchangeBroker({
    connack: (index) => (index === 1 ? {} : { sessionPresent: true, receiveMaximum: 1 }),
    answer: (packet, index) => (index === 1 ? undefined : acknowledge(packet)),
  });
  const sessionState = createSessionState();
  const first = await connect(peer.transport, sessionState).connecting;
  const publications = [
    first.publish('a', '1', qosTwo),
    first.publish('b', '2', qosOne),
    first.publish('c', '3', qosTwo),
    first.publish('d', '4', qosTwo),
  ];
  await settle();
  peer.connection(0).deliver(pubrec(4));
  peer.connection(0).deliver(pubrec(1));
  await settle();
  expect(sessionState.inFlight).toEqual([
    { topic: 'd', messageId: 4, qos: 2, acknowledged: true },
    { topic: 'a', messageId: 1, qos: 2, acknowledged: true },
    { topic: 'b', messageId: 2, qos: 1, acknowledged: false },
    { topic: 'c', messageId: 3, qos: 2, acknowledged: false },
  ]);
  await lose(peer.connection(0), publications);
  const second = await connect(peer.transport, sessionState, { cleanStart: false }).connecting;
  const next = second.publish('e', 'new', qosTwo);
  await settle();
  await next;
  expect(peer.sent(1)).toEqual([
    'pubrel 4',
    'pubrel 1',
    'publish b qos 1 id 2 dup',
    'publish c qos 2 id 3 dup',
    'pubrel 3',
    'publish e qos 2 id 1',
    'pubrel 1',
  ]);
  expect(sessionState.inFlight).toEqual([]);
  await second.disconnect();
});

test('MQTT-3.3.4-8: a resumed session sends every stored PUBREL although the send quota is used up', async () => {
  const peer = exchangeBroker({
    connack: (index) => (index === 1 ? {} : { sessionPresent: true, receiveMaximum: 1 }),
    answer: (packet, index) => (index === 1 && packet.cmd === 'publish' ? acknowledge(packet) : undefined),
  });
  const sessionState = createSessionState();
  const first = await connect(peer.transport, sessionState).connecting;
  const publications = [first.publish('a', '1', qosTwo), first.publish('b', '2', qosTwo)];
  await settle();
  await lose(peer.connection(0), publications);
  const stored = [
    { topic: 'a', messageId: 1, qos: 2, acknowledged: true },
    { topic: 'b', messageId: 2, qos: 2, acknowledged: true },
  ];
  expect(sessionState.inFlight).toEqual(stored);
  const { connecting, ends } = connect(peer.transport, sessionState, { cleanStart: false });
  await connecting;
  await settle();
  // Section 4.9: a PUBREL takes no quota, and the client must not delay a packet other than PUBLISH.
  expect(peer.sent(1)).toEqual(['pubrel 1', 'pubrel 2']);
  peer.connection(1).end();
  await settle();
  expect(ends).toMatchObject([{ kind: 'error', uncertain: stored }]);
  expect(sessionState.inFlight).toEqual(stored);
});

test('a resumed PUBREL holds its quota slot against a new PUBLISH until its PUBCOMP', async () => {
  const peer = exchangeBroker({
    connack: (index) => (index === 1 ? {} : { sessionPresent: true, receiveMaximum: 2 }),
    answer: (packet, index) => (index === 1 && packet.cmd === 'publish' ? acknowledge(packet) : undefined),
  });
  const sessionState = createSessionState();
  const first = await connect(peer.transport, sessionState).connecting;
  const publications = [first.publish('a', '1', qosTwo), first.publish('b', '2', qosTwo), first.publish('c', '3', qosTwo)];
  await settle();
  await lose(peer.connection(0), publications);
  const second = await connect(peer.transport, sessionState, { cleanStart: false }).connecting;
  const next = second.publish('d', 'new', qosOne);
  await settle();
  expect(peer.sent(1)).toEqual(['pubrel 1', 'pubrel 2', 'pubrel 3']);
  peer.connection(1).deliver({ cmd: 'pubcomp', messageId: 1, reasonCode: 0 });
  await settle();
  // Three exchanges were open against a Receive Maximum of 2, so one PUBCOMP frees no slot.
  expect(peer.sent(1)).toEqual(['pubrel 1', 'pubrel 2', 'pubrel 3']);
  peer.connection(1).deliver({ cmd: 'pubcomp', messageId: 3, reasonCode: 0 });
  await settle();
  expect(peer.sent(1)).toEqual(['pubrel 1', 'pubrel 2', 'pubrel 3', 'publish d qos 1 id 1']);
  peer.connection(1).deliver({ cmd: 'puback', messageId: 1, reasonCode: 0 });
  await next;
  await second.disconnect({ drain: false });
});

test('a PUBREC for a stored PUBLISH that still waits for quota gets no PUBREL, and the PUBLISH goes out again', async () => {
  const peer = exchangeBroker({ connack: (index) => (index === 1 ? {} : { sessionPresent: true, receiveMaximum: 1 }) });
  const sessionState = createSessionState();
  const first = await connect(peer.transport, sessionState).connecting;
  const publications = [first.publish('a', '1', qosTwo), first.publish('b', '2', qosTwo)];
  await settle();
  await lose(peer.connection(0), publications);
  const second = await connect(peer.transport, sessionState, { cleanStart: false }).connecting;
  await settle();
  expect(peer.sent(1)).toEqual(['publish a qos 2 id 1 dup']);
  // The broker answers the PUBLISH of the earlier connection. The client still stores that exchange.
  peer.connection(1).deliver(pubrec(2));
  await settle();
  expect(peer.sent(1)).toEqual(['publish a qos 2 id 1 dup']);
  peer.connection(1).deliver(pubrec(1));
  await settle();
  peer.connection(1).deliver({ cmd: 'pubcomp', messageId: 1, reasonCode: 0 });
  await settle();
  expect(peer.sent(1)).toEqual(['publish a qos 2 id 1 dup', 'pubrel 1', 'publish b qos 2 id 2 dup']);
  expect(sessionState.inFlight).toEqual([{ topic: 'b', messageId: 2, qos: 2, acknowledged: false }]);
  await second.disconnect({ drain: false });
});

test('MQTT-4.4.0-2: a refusing PUBREC ends the stored exchange, so a resumed session sends nothing for it', async () => {
  const peer = exchangeBroker({
    connack: (index) => ({ sessionPresent: index === 2 }),
    hold: (packet, index) => index === 1 && packet.cmd === 'publish',
  });
  const sessionState = createSessionState();
  const { connecting, ends } = connect(peer.transport, sessionState);
  const first = await connecting;
  const refused = first.publish('a', '1', qosTwo);
  await settle();
  expect(sessionState.inFlight).toEqual([{ topic: 'a', messageId: 1, qos: 2, acknowledged: false }]);
  peer.connection(0).deliver(pubrec(1, 0x97));
  await settle();
  expect(sessionState.inFlight).toEqual([]);
  await lose(peer.connection(0), [refused]);
  // The PUBLISH write was still pending, so the session end lists the publication although its exchange is over.
  expect(ends).toMatchObject([{ kind: 'error', uncertain: [{ topic: 'a', messageId: 1, qos: 2, acknowledged: false }] }]);
  const second = await connect(peer.transport, sessionState, { cleanStart: false }).connecting;
  await settle();
  expect(peer.sent(1)).toEqual([]);
  await second.disconnect();
});

test('a stored QoS 2 PUBLISH conflicts with a lower Maximum QoS and stays stored', async () => {
  const peer = exchangeBroker({ connack: (index) => (index === 1 ? {} : { sessionPresent: true, maximumQoS: 1 }) });
  const sessionState = createSessionState();
  const first = await connect(peer.transport, sessionState).connecting;
  const lost = first.publish('a', '1', qosTwo);
  await settle();
  await lose(peer.connection(0), [lost]);
  await expect(connect(peer.transport, sessionState, { cleanStart: false }).connecting).rejects.toMatchObject({
    code: 'ERR_MQTT_SESSION_CONFLICT',
    reasonCode: 0,
    message: 'MQTT broker no longer accepts the stored QoS 2 publications',
  });
  expect(peer.sent(1)).toEqual(['disconnect']);
  expect(sessionState.inFlight).toEqual([{ topic: 'a', messageId: 1, qos: 2, acknowledged: false }]);
});

test('a stored PUBREL goes out to a broker whose Maximum QoS is now 0', async () => {
  const peer = exchangeBroker({
    connack: (index) => (index === 1 ? {} : { sessionPresent: true, maximumQoS: 0 }),
    answer: (packet, index) => (index === 1 && packet.cmd === 'pubrel' ? undefined : acknowledge(packet)),
  });
  const sessionState = createSessionState();
  const first = await connect(peer.transport, sessionState).connecting;
  const lost = first.publish('a', '1', qosTwo);
  await settle();
  await lose(peer.connection(0), [lost]);
  const second = await connect(peer.transport, sessionState, { cleanStart: false }).connecting;
  await settle();
  expect(peer.sent(1)).toEqual(['pubrel 1']);
  expect(sessionState.inFlight).toEqual([]);
  await second.disconnect();
});

function supervise(transport: Readonly<ByteTransport>) {
  const events: ReconnectEvent[] = [];
  const client = createReconnectingClient<ByteClientOptions>(
    createTransportClient.bind(undefined, transport),
    { clientId: 'resume', sessionExpiryInterval: 600 },
    {
      random: () => 0,
      resume: true,
      onReconnect(event) {
        events.push(event);
      },
    },
  );
  return { client, events };
}

test('the reconnecting client reports the PUBREC and PUBCOMP of each exchange it continued', async () => {
  const peer = exchangeBroker({
    connack: (index) => ({ sessionPresent: index !== 1 }),
    answer: (packet, index) =>
      index === 1 ? (packet.cmd === 'publish' && packet.topic === 'b' ? acknowledge(packet) : undefined) : acknowledge(packet),
  });
  const { client, events } = supervise(peer.transport);
  const first = await client.session();
  const publications = [first.publish('a', '1', qosTwo), first.publish('b', '2', qosTwo)];
  await vi.advanceTimersByTimeAsync(0);
  await lose(peer.connection(0), publications);
  await vi.advanceTimersByTimeAsync(500);
  await client.session();
  await vi.advanceTimersByTimeAsync(0);
  expect(peer.sent(1)).toEqual(['pubrel 2', 'publish a qos 2 id 1 dup', 'pubrel 1']);
  expect(events.slice(1)).toMatchObject([
    { kind: 'retrying', attempt: 2 },
    {
      kind: 'connected',
      resumed: true,
      resent: [
        { topic: 'b', messageId: 2, qos: 2, acknowledged: true },
        { topic: 'a', messageId: 1, qos: 2, acknowledged: false },
      ],
      previous: {
        kind: 'error',
        uncertain: [
          { topic: 'a', messageId: 1, qos: 2, acknowledged: false },
          { topic: 'b', messageId: 2, qos: 2, acknowledged: true },
        ],
      },
    },
    { kind: 'pubcomp', topic: 'b', messageId: 2, reasonCode: 0 },
    { kind: 'pubrec', topic: 'a', messageId: 1, reasonCode: 0 },
    { kind: 'pubcomp', topic: 'a', messageId: 1, reasonCode: 0 },
  ]);
  await client.disconnect();
});

test('the reconnecting client reports a refused PUBREC and a PUBCOMP with reason 0x92 for continued exchanges', async () => {
  const peer = exchangeBroker({
    connack: (index) => ({ sessionPresent: index !== 1 }),
    answer(packet, index) {
      if (index === 1) return packet.cmd === 'publish' && packet.topic === 'b' ? acknowledge(packet) : undefined;
      if (packet.cmd === 'publish') return [pubrec(packet.messageId ?? 0, 0x97)];
      return packet.cmd === 'pubrel' ? [{ cmd: 'pubcomp', messageId: packet.messageId ?? 0, reasonCode: 0x92 }] : undefined;
    },
  });
  const { client, events } = supervise(peer.transport);
  const first = await client.session();
  const publications = [first.publish('a', '1', qosTwo), first.publish('b', '2', qosTwo)];
  await vi.advanceTimersByTimeAsync(0);
  await lose(peer.connection(0), publications);
  await vi.advanceTimersByTimeAsync(500);
  await client.session();
  await vi.advanceTimersByTimeAsync(0);
  expect(peer.sent(1)).toEqual(['pubrel 2', 'publish a qos 2 id 1 dup']);
  expect(events.slice(3)).toEqual([
    { kind: 'pubcomp', topic: 'b', messageId: 2, reasonCode: 0x92 },
    { kind: 'pubrec', topic: 'a', messageId: 1, reasonCode: 0x97 },
  ]);
  await client.disconnect();
});

test('the reconnecting client lists dropped QoS 2 publications after Session Present false', async () => {
  const peer = exchangeBroker({
    answer: (packet, index) => (index === 1 && packet.cmd === 'publish' && packet.topic === 'b' ? acknowledge(packet) : undefined),
  });
  const { client, events } = supervise(peer.transport);
  const first = await client.session();
  const publications = [first.publish('a', '1', qosTwo), first.publish('b', '2', qosTwo)];
  await vi.advanceTimersByTimeAsync(0);
  await lose(peer.connection(0), publications);
  await vi.advanceTimersByTimeAsync(500);
  await client.session();
  await vi.advanceTimersByTimeAsync(0);
  expect(peer.sent(1)).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    kind: 'connected',
    resumed: false,
    dropped: [
      { topic: 'b', messageId: 2, qos: 2, acknowledged: true },
      { topic: 'a', messageId: 1, qos: 2, acknowledged: false },
    ],
  });
  expect(events.at(-1)).not.toHaveProperty('resent');
  await client.disconnect();
});

test('the reconnecting client restores a QoS 2 subscription and rejects an invalid QoS', async () => {
  const peer = exchangeBroker();
  const client = createReconnectingClient<ByteClientOptions>(
    createTransportClient.bind(undefined, peer.transport),
    { clientId: 'resume', onQosOneMessage() {}, onQosTwoMessage() {} },
    { subscriptions: [{ topic: 'a', qos: 2 }] },
  );
  await client.session();
  expect(peer.connection(0).packets[1]).toMatchObject({ cmd: 'subscribe', topics: ['a'], qos: 2 });
  await client.disconnect();
  const invalid: unknown = { subscriptions: [{ topic: 'a', qos: 3 }] };
  expect(() => {
    Reflect.apply(createReconnectingClient, undefined, [
      () => createTransportClient(peer.transport, { clientId: 'x' }),
      {},
      invalid,
    ]);
  }).toThrow(new RangeError('Invalid MQTT subscription QoS'));
});

/** Handlers that record each QoS 2 delivery as its Packet Identifier, with ` dup` when DUP is set. */
function receiver(): { delivered: string[]; handlers: Options } {
  const delivered: string[] = [];
  return {
    delivered,
    handlers: {
      onQosOneMessage() {},
      onQosTwoMessage(message: Readonly<{ messageId: number; dup: boolean }>) {
        delivered.push(`${String(message.messageId)}${message.dup ? ' dup' : ''}`);
      },
    },
  };
}

function inbound(messageId: number, dup = false): Delivery {
  return { cmd: 'publish', topic: 'a', payload: 'hi', qos: 2, messageId, dup };
}

test('an inbound QoS 2 Packet Identifier survives a resume, so the duplicate PUBLISH is not delivered again', async () => {
  const peer = exchangeBroker({ connack: (index) => ({ sessionPresent: index === 2 }) });
  const sessionState = createSessionState();
  const { delivered, handlers } = receiver();
  await connect(peer.transport, sessionState, handlers).connecting;
  peer.connection(0).deliver(inbound(7));
  await settle();
  expect(peer.connection(0).frames).toEqual([[0x50, 2, 0, 7]]);
  peer.connection(0).end();
  await settle();
  const second = await connect(peer.transport, sessionState, { ...handlers, cleanStart: false }).connecting;
  peer.connection(1).deliver(inbound(7, true));
  await settle();
  peer.connection(1).deliver({ cmd: 'pubrel', messageId: 7, reasonCode: 0 });
  await settle();
  peer.connection(1).deliver({ cmd: 'pubrel', messageId: 7, reasonCode: 0 });
  await settle();
  expect(delivered).toEqual(['7']);
  expect(peer.connection(1).frames).toEqual([
    [0x50, 2, 0, 7],
    [0x70, 2, 0, 7],
    [0x70, 3, 0, 7, 0x92],
  ]);
  await second.disconnect();
});

test.each([
  ['PUBREL', [0x70, 2, 0, 7]],
  ['duplicate PUBLISH', [0x50, 2, 0, 7]],
] as const)('a %s in one chunk with the CONNACK of a resumed session finds the stored identifier', async (kind, answer) => {
  const packet: Delivery = kind === 'PUBREL' ? { cmd: 'pubrel', messageId: 7, reasonCode: 0 } : inbound(7, true);
  const peer = exchangeBroker({
    connack: (index) => ({ sessionPresent: index === 2 }),
    answer: (received, index) => (index === 2 && received.cmd === 'connect' ? [packet] : undefined),
  });
  const sessionState = createSessionState();
  const { delivered, handlers } = receiver();
  await connect(peer.transport, sessionState, handlers).connecting;
  peer.connection(0).deliver(inbound(7));
  await settle();
  peer.connection(0).end();
  await settle();
  const second = await connect(peer.transport, sessionState, { ...handlers, cleanStart: false }).connecting;
  await settle();
  expect(delivered).toEqual(['7']);
  expect(peer.connection(1).frames).toEqual([answer]);
  await second.disconnect();
});

test('a new session forgets the inbound QoS 2 Packet Identifiers', async () => {
  const peer = exchangeBroker();
  const sessionState = createSessionState();
  const { delivered, handlers } = receiver();
  await connect(peer.transport, sessionState, handlers).connecting;
  peer.connection(0).deliver(inbound(7));
  await settle();
  peer.connection(0).end();
  await settle();
  const second = await connect(peer.transport, sessionState, { ...handlers, cleanStart: false }).connecting;
  peer.connection(1).deliver(inbound(7));
  await settle();
  expect(delivered).toEqual(['7', '7']);
  await second.disconnect();
});

test('a PUBLISH in one chunk with the CONNACK of a new session is delivered although the old session stored its identifier', async () => {
  const peer = exchangeBroker({
    answer: (received, index) => (index === 2 && received.cmd === 'connect' ? [inbound(7)] : undefined),
  });
  const sessionState = createSessionState();
  const { delivered, handlers } = receiver();
  await connect(peer.transport, sessionState, handlers).connecting;
  peer.connection(0).deliver(inbound(7));
  await settle();
  peer.connection(0).end();
  await settle();
  const second = await connect(peer.transport, sessionState, { ...handlers, cleanStart: false }).connecting;
  await settle();
  expect(delivered).toEqual(['7', '7']);
  expect(peer.connection(1).frames).toEqual([[0x50, 2, 0, 7]]);
  await second.disconnect();
});

test('a handler that failed does not store the identifier, so the resumed session delivers the PUBLISH again', async () => {
  const peer = exchangeBroker({ connack: (index) => ({ sessionPresent: index === 2 }) });
  const sessionState = createSessionState();
  const { delivered, handlers } = receiver();
  await connect(peer.transport, sessionState, {
    onQosOneMessage() {},
    onQosTwoMessage() {
      throw new Error('store failed');
    },
  }).connecting;
  peer.connection(0).deliver(inbound(7));
  await settle();
  expect(peer.connection(0).frames).toEqual([]);
  const second = await connect(peer.transport, sessionState, { ...handlers, cleanStart: false }).connecting;
  peer.connection(1).deliver(inbound(7, true));
  await settle();
  expect(delivered).toEqual(['7 dup']);
  expect(peer.connection(1).frames).toEqual([[0x50, 2, 0, 7]]);
  await second.disconnect();
});

test('a handler that finishes after its connection ended keeps the identifier for the resumed session', async () => {
  const peer = exchangeBroker({ connack: (index) => ({ sessionPresent: index === 2 }) });
  const sessionState = createSessionState();
  const { delivered, handlers } = receiver();
  let finish: () => void = () => {};
  await connect(peer.transport, sessionState, {
    onQosOneMessage() {},
    async onQosTwoMessage() {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  }).connecting;
  peer.connection(0).deliver(inbound(7));
  await settle();
  peer.connection(0).end();
  await settle();
  finish();
  await settle();
  const second = await connect(peer.transport, sessionState, { ...handlers, cleanStart: false }).connecting;
  peer.connection(1).deliver(inbound(7, true));
  await settle();
  expect(delivered).toEqual([]);
  expect(peer.connection(1).frames).toEqual([[0x50, 2, 0, 7]]);
  await second.disconnect();
});

/** A receiver whose first QoS 2 handler call stays pending until the test fails or fulfills it. */
function lateHandler() {
  const calls: string[] = [];
  let fulfill: () => void = () => {};
  let reject: (reason: Readonly<Error>) => void = () => {};
  const first = new Promise<void>((resolve, refuse) => {
    fulfill = resolve;
    reject = refuse;
  });
  first.catch(() => {});
  const handlers: Options = {
    onQosOneMessage() {},
    async onQosTwoMessage({ topic, messageId, dup }: Readonly<{ topic: string; messageId: number; dup: boolean }>) {
      calls.push(`${topic} id ${String(messageId)}${dup ? ' dup' : ''}`);
      if (calls.length === 1) await first;
    },
  };
  const fail = (): void => {
    reject(new Error('the first handler fails late'));
  };
  return { calls, handlers, fail, fulfill };
}

function message(topic: string, messageId: number, dup = false): Delivery {
  return { cmd: 'publish', topic, payload: topic, qos: 2, messageId, dup };
}

const pubrecOne = [0x50, 2, 0, 1];
const pubcompOne = [0x70, 2, 0, 1];

test('MQTT-4.3.3-10: a handler of an earlier connection that fails late causes no second delivery of a newer message', async () => {
  const peer = exchangeBroker({ connack: (index) => ({ sessionPresent: index >= 2 }) });
  const sessionState = createSessionState();
  const { calls, handlers, fail } = lateHandler();
  await connect(peer.transport, sessionState, handlers).connecting;
  peer.connection(0).deliver(message('A', 1));
  await settle();
  // The handler of A still runs when its connection ends.
  peer.connection(0).end();
  await settle();
  await connect(peer.transport, sessionState, { ...handlers, cleanStart: false }).connecting;
  const second = peer.connection(1);
  second.deliver(message('A', 1, true));
  await settle();
  second.deliver({ cmd: 'pubrel', messageId: 1, reasonCode: 0 });
  await settle();
  // The exchange of A is over, so the broker may give Packet Identifier 1 to B.
  second.deliver(message('B', 1));
  await settle();
  expect(second.frames).toEqual([pubrecOne, pubcompOne, pubrecOne]);
  // The PUBREC for B is lost with the connection.
  second.end();
  await settle();
  fail();
  await settle();
  await connect(peer.transport, sessionState, { ...handlers, cleanStart: false }).connecting;
  peer.connection(2).deliver(message('B', 1, true));
  await settle();
  expect(peer.connection(2).frames).toEqual([pubrecOne]);
  expect(calls).toEqual(['A id 1', 'B id 1']);
});

test('a handler of an earlier session that fails late leaves the exchange that now has its Packet Identifier', async () => {
  const peer = exchangeBroker();
  const sessionState = createSessionState();
  const { calls, handlers, fail } = lateHandler();
  await connect(peer.transport, sessionState, handlers).connecting;
  peer.connection(0).deliver(message('A', 1));
  await settle();
  peer.connection(0).end();
  await settle();
  // Session Present false starts a new session, whose broker counts its Packet Identifiers from 1 again.
  const { connecting, ends } = connect(peer.transport, sessionState, handlers);
  await connecting;
  const second = peer.connection(1);
  second.deliver(message('B', 1));
  await settle();
  fail();
  await settle();
  second.deliver({ cmd: 'pubrel', messageId: 1, reasonCode: 0 });
  await settle();
  second.deliver(message('C', 2));
  await settle();
  expect(second.frames).toEqual([pubrecOne, pubcompOne, [0x50, 2, 0, 2]]);
  expect(calls).toEqual(['A id 1', 'B id 1', 'C id 2']);
  expect(ends).toEqual([]);
});

test('a handler of an earlier connection that fails late frees its own Packet Identifier for the next PUBLISH', async () => {
  const peer = exchangeBroker({ connack: (index) => ({ sessionPresent: index >= 2 }) });
  const sessionState = createSessionState();
  const { calls, handlers, fail } = lateHandler();
  await connect(peer.transport, sessionState, handlers).connecting;
  peer.connection(0).deliver(message('A', 1));
  await settle();
  peer.connection(0).end();
  await settle();
  fail();
  await settle();
  const second = await connect(peer.transport, sessionState, { ...handlers, cleanStart: false }).connecting;
  peer.connection(1).deliver(message('A', 1, true));
  await settle();
  expect(calls).toEqual(['A id 1', 'A id 1 dup']);
  expect(peer.connection(1).frames).toEqual([pubrecOne]);
  await second.disconnect();
});

test('a handler of an earlier connection that fulfills late does not record a Packet Identifier whose exchange ended', async () => {
  const peer = exchangeBroker({ connack: (index) => ({ sessionPresent: index >= 2 }) });
  const sessionState = createSessionState();
  const { calls, handlers, fulfill } = lateHandler();
  await connect(peer.transport, sessionState, handlers).connecting;
  peer.connection(0).deliver(message('A', 1));
  await settle();
  peer.connection(0).end();
  await settle();
  const second = await connect(peer.transport, sessionState, { ...handlers, cleanStart: false }).connecting;
  peer.connection(1).deliver(message('A', 1, true));
  await settle();
  peer.connection(1).deliver({ cmd: 'pubrel', messageId: 1, reasonCode: 0 });
  await settle();
  fulfill();
  await settle();
  // The exchange of A is over, so Packet Identifier 1 names a new message and not a duplicate.
  peer.connection(1).deliver(message('B', 1));
  await settle();
  expect(calls).toEqual(['A id 1', 'B id 1']);
  expect(peer.connection(1).frames).toEqual([pubrecOne, pubcompOne, pubrecOne]);
  await second.disconnect();
});
