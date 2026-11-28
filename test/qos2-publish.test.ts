import { afterEach, expect, test, vi } from 'vitest';
import { createSessionState, createTransportClient, type ByteClientOptions, type SessionEnd } from '../src/portableClient.js';
import { acknowledge, exchangeBroker, settle, type Delivery, type ExchangeScript } from './experiments/exchange-broker.js';

const qosTwo = { qos: 2 } as const;
const qosOne = { qos: 1 } as const;

afterEach(() => {
  vi.useRealTimers();
});

type Limits = Readonly<Pick<ByteClientOptions, 'timeoutMs' | 'maxBufferedBytes' | 'reservedControlBytes' | 'sessionState'>>;

async function publisher(script: Readonly<ExchangeScript> = {}, options: Limits = {}) {
  const peer = exchangeBroker(script);
  const ends: SessionEnd[] = [];
  const session = await createTransportClient(peer.transport, {
    clientId: 'publisher',
    onSessionEnd(event) {
      ends.push(event);
    },
    ...options,
  }).connect();
  const sent = (): string[] => peer.sent(0);
  return { session, connection: peer.connection(0), ends, sent, releaseWrites: peer.releaseWrites };
}

function pubrec(messageId: number, reasonCode = 0): Delivery {
  return { cmd: 'pubrec', messageId, reasonCode };
}

function pubcomp(messageId: number, reasonCode = 0): Delivery {
  return { cmd: 'pubcomp', messageId, reasonCode };
}

/** The state of a promise after the pending microtasks ran. */
async function stateOf(promise: Readonly<Promise<unknown>>): Promise<'pending' | 'fulfilled' | 'rejected'> {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  promise.then(
    () => {
      state = 'fulfilled';
    },
    () => {
      state = 'rejected';
    },
  );
  await settle();
  return state;
}

test('a QoS 2 publish writes PUBLISH, answers PUBREC with PUBREL and resolves on PUBCOMP', async () => {
  const { session, connection } = await publisher();
  const publishing = session.publish('a', 'hi', qosTwo);
  await settle();
  expect(connection.frames).toEqual([[0x34, 8, 0, 1, 0x61, 0, 1, 0, 0x68, 0x69]]);
  connection.deliverBytes([0x50, 2, 0, 1]);
  await expect(stateOf(publishing)).resolves.toBe('pending');
  expect(connection.frames.slice(1)).toEqual([[0x62, 2, 0, 1]]);
  connection.deliverBytes([0x70, 2, 0, 1]);
  await expect(publishing).resolves.toBeUndefined();
  expect(connection.frames).toHaveLength(2);
  await session.disconnect();
});

test('a QoS 2 publish carries its properties and retain flag', async () => {
  const { session, connection } = await publisher({ answer: acknowledge });
  await session.publish('a', Uint8Array.of(1, 2), { qos: 2, retain: true, contentType: 'x', userProperties: [['k', 'v']] });
  expect(connection.packets[1]).toEqual({
    cmd: 'publish',
    topic: 'a',
    payload: Uint8Array.of(1, 2),
    qos: 2,
    messageId: 1,
    dup: false,
    retain: true,
    contentType: 'x',
    userProperties: [['k', 'v']],
  });
  await session.disconnect();
});

test('a PUBREC with a reason of 0x80 or above rejects the publish, sends no PUBREL and frees the quota slot', async () => {
  const { session, connection, sent } = await publisher({ connack: () => ({ receiveMaximum: 1 }) });
  const refused = session.publish('a', 'one', qosTwo);
  const next = session.publish('b', 'two', qosTwo);
  await settle();
  expect(sent()).toEqual(['publish a qos 2 id 1']);
  connection.deliver(pubrec(1, 0x97));
  await expect(refused).rejects.toMatchObject({
    code: 'ERR_MQTT_REFUSED',
    fatal: false,
    reasonCode: 0x97,
    message: 'MQTT publication refused',
  });
  await settle();
  expect(sent()).toEqual(['publish a qos 2 id 1', 'publish b qos 2 id 2']);
  connection.deliver(pubrec(2));
  await settle();
  connection.deliver(pubcomp(2));
  await expect(next).resolves.toBeUndefined();
  expect(sent()).toEqual(['publish a qos 2 id 1', 'publish b qos 2 id 2', 'pubrel 2']);
  await session.disconnect();
});

test('QoS 1 and QoS 2 publications share the Receive Maximum, and a QoS 2 slot stays held until PUBCOMP', async () => {
  const { session, connection, sent } = await publisher({ connack: () => ({ receiveMaximum: 2 }) });
  const publications = [
    session.publish('a', '1', qosTwo),
    session.publish('b', '2', qosOne),
    session.publish('c', '3', qosTwo),
    session.publish('d', '4', qosOne),
  ];
  await settle();
  expect(sent()).toEqual(['publish a qos 2 id 1', 'publish b qos 1 id 2']);
  connection.deliver(pubrec(1));
  await settle();
  expect(sent()).toEqual(['publish a qos 2 id 1', 'publish b qos 1 id 2', 'pubrel 1']);
  connection.deliver({ cmd: 'puback', messageId: 2, reasonCode: 0 });
  await settle();
  expect(sent().slice(3)).toEqual(['publish c qos 2 id 3']);
  connection.deliver(pubcomp(1));
  await settle();
  expect(sent().slice(4)).toEqual(['publish d qos 1 id 4']);
  connection.deliver(pubrec(3));
  connection.deliver({ cmd: 'puback', messageId: 4, reasonCode: 0 });
  await settle();
  connection.deliver(pubcomp(3));
  await expect(Promise.all(publications)).resolves.toHaveLength(4);
  await session.disconnect();
});

test('a duplicate PUBREC and a duplicate PUBCOMP change nothing', async () => {
  const { session, connection, sent } = await publisher();
  const publishing = session.publish('a', 'hi', qosTwo);
  await settle();
  connection.deliver(pubrec(1));
  await settle();
  connection.deliver(pubrec(1));
  connection.deliver(pubrec(1, 0x80));
  await expect(stateOf(publishing)).resolves.toBe('pending');
  expect(sent()).toEqual(['publish a qos 2 id 1', 'pubrel 1']);
  connection.deliver(pubcomp(1));
  connection.deliver(pubcomp(1));
  await expect(publishing).resolves.toBeUndefined();
  await session.ping();
  expect(sent()).toEqual(['publish a qos 2 id 1', 'pubrel 1', 'pingreq']);
  await session.disconnect();
});

test('a PUBREC for an unknown Packet Identifier gets PUBREL with reason 0x92 only when it accepts', async () => {
  const { session, connection } = await publisher();
  connection.deliver(pubrec(9));
  connection.deliver(pubrec(10, 0x80));
  await settle();
  expect(connection.frames).toEqual([[0x62, 3, 0, 9, 0x92]]);
  await session.ping();
  await session.disconnect();
});

test('a PUBCOMP before PUBREC and a PUBCOMP for an unknown Packet Identifier leave the exchange pending', async () => {
  const { session, connection, sent } = await publisher();
  const publishing = session.publish('a', 'hi', qosTwo);
  await settle();
  connection.deliver(pubcomp(1));
  connection.deliver(pubcomp(9, 0x92));
  await expect(stateOf(publishing)).resolves.toBe('pending');
  expect(sent()).toEqual(['publish a qos 2 id 1']);
  connection.deliver(pubrec(1));
  await settle();
  connection.deliver(pubcomp(1));
  await expect(publishing).resolves.toBeUndefined();
  expect(sent()).toEqual(['publish a qos 2 id 1', 'pubrel 1']);
  await session.disconnect();
});

test('an acknowledgment of the other QoS leaves an exchange pending', async () => {
  const { session, connection, sent } = await publisher();
  const exactlyOnce = session.publish('a', 'hi', qosTwo);
  const atLeastOnce = session.publish('b', 'hi', qosOne);
  await settle();
  connection.deliver({ cmd: 'puback', messageId: 1, reasonCode: 0 });
  connection.deliver(pubrec(2));
  connection.deliver(pubcomp(2));
  await expect(stateOf(exactlyOnce)).resolves.toBe('pending');
  await expect(stateOf(atLeastOnce)).resolves.toBe('pending');
  expect(sent()).toEqual(['publish a qos 2 id 1', 'publish b qos 1 id 2']);
  connection.deliver({ cmd: 'puback', messageId: 2, reasonCode: 0 });
  connection.deliver(pubrec(1));
  await settle();
  connection.deliver(pubcomp(1));
  await expect(Promise.all([exactlyOnce, atLeastOnce])).resolves.toHaveLength(2);
  await session.disconnect();
});

test('a PUBCOMP with reason 0x92 ends the exchange and resolves the publish', async () => {
  const { session, connection } = await publisher();
  const publishing = session.publish('a', 'hi', qosTwo);
  await settle();
  connection.deliver(pubrec(1));
  await settle();
  connection.deliverBytes([0x70, 3, 0, 1, 0x92]);
  await expect(publishing).resolves.toBeUndefined();
  await session.disconnect();
});

test.each([
  ['a PUBREC with Packet Identifier 0', [0x50, 2, 0, 0], { code: 'ERR_MQTT_PROTOCOL', reasonCode: 0x82 }],
  ['a PUBCOMP with Packet Identifier 0', [0x70, 2, 0, 0], { code: 'ERR_MQTT_PROTOCOL', reasonCode: 0x82 }],
  ['a PUBREC with an unknown reason code', [0x50, 3, 0, 1, 0x92], { message: 'Invalid PUBREC reason code' }],
  ['a PUBCOMP with an unknown reason code', [0x70, 3, 0, 1, 0x80], { message: 'Invalid PUBCOMP reason code' }],
  ['a PUBREL with an unknown reason code', [0x62, 3, 0, 1, 0x80], { message: 'Invalid PUBREL reason code' }],
  ['a PUBREL with flags 0', [0x60, 2, 0, 1], { message: 'Invalid header flag bits, must be 0x2 for pubrel packet' }],
] as const)('%s ends the session', async (_name, bytes, failure) => {
  const { session, connection, ends } = await publisher();
  const publishing = session.publish('a', 'hi', qosTwo);
  await settle();
  connection.deliverBytes(bytes);
  await expect(publishing).rejects.toMatchObject(failure);
  expect(ends).toMatchObject([{ kind: 'error', error: failure }]);
});

test.each([
  ['the order of the PUBLISH packets', [1, 2]],
  ['the reverse order', [2, 1]],
] as const)('PUBREL follows its PUBREC at once, in %s, while the first PUBLISH write is pending', async (_name, order) => {
  // MQTT-4.6.0-4: the client sends PUBREL packets in the order in which the PUBREC packets arrived.
  const { session, connection, sent, releaseWrites } = await publisher({
    hold: (packet) => packet.cmd === 'publish' && packet.topic === 'a',
  });
  const first = session.publish('a', 'one', qosTwo);
  const second = session.publish('b', 'two', qosTwo);
  await settle();
  for (const messageId of order) connection.deliver(pubrec(messageId));
  await settle();
  expect(sent()).toEqual([
    'publish a qos 2 id 1',
    'publish b qos 2 id 2',
    `pubrel ${String(order[0])}`,
    `pubrel ${String(order[1])}`,
  ]);
  connection.deliver(pubcomp(1));
  connection.deliver(pubcomp(2));
  await expect(second).resolves.toBeUndefined();
  // The first exchange keeps its slot until its PUBLISH write settles.
  await expect(stateOf(first)).resolves.toBe('pending');
  releaseWrites();
  await expect(first).resolves.toBeUndefined();
  await session.disconnect();
});

test.each([
  [0, 'rejected'],
  [1, 'fulfilled'],
] as const)('a broker Maximum QoS of %i rejects a QoS 2 publish before any write', async (maximumQoS, qosOneOutcome) => {
  const { session, connection } = await publisher({ connack: () => ({ maximumQoS }), answer: acknowledge });
  expect(session.connection.maximumQos).toBe(maximumQoS);
  await expect(session.publish('a', 'hi', qosTwo)).rejects.toMatchObject({
    code: 'ERR_MQTT_INVALID_ARGUMENT',
    fatal: false,
    message: 'Broker does not support QoS 2',
  });
  expect(connection.frames).toEqual([]);
  await expect(stateOf(session.publish('a', 'hi', qosOne))).resolves.toBe(qosOneOutcome);
  await session.publish('a', 'hi');
  await session.disconnect();
});

test('an abort withdraws a queued QoS 2 publication', async () => {
  const { session, connection, sent } = await publisher({ connack: () => ({ receiveMaximum: 1 }), answer: acknowledge });
  const controller = new AbortController();
  const reason = new Error('changed my mind');
  const first = session.publish('a', 'one', qosTwo);
  const queued = session.publish('b', 'two', { qos: 2, signal: controller.signal });
  controller.abort(reason);
  await expect(queued).rejects.toBe(reason);
  await first;
  await session.publish('c', 'three', qosTwo);
  expect(sent()).toEqual(['publish a qos 2 id 1', 'pubrel 1', 'publish c qos 2 id 2', 'pubrel 2']);
  expect(connection.frames).toHaveLength(4);
  await session.disconnect();
});

test('an abort after dispatch settles the caller, and the exchange still runs to PUBCOMP', async () => {
  const { session, connection, sent } = await publisher({ connack: () => ({ receiveMaximum: 1 }) });
  const controller = new AbortController();
  const reason = new Error('stopped waiting');
  const first = session.publish('a', 'one', { qos: 2, signal: controller.signal });
  const second = session.publish('b', 'two', qosTwo);
  await settle();
  controller.abort(reason);
  await expect(first).rejects.toBe(reason);
  expect(sent()).toEqual(['publish a qos 2 id 1']);
  connection.deliver(pubrec(1));
  await settle();
  expect(sent()).toEqual(['publish a qos 2 id 1', 'pubrel 1']);
  connection.deliver(pubcomp(1));
  await settle();
  expect(sent()).toEqual(['publish a qos 2 id 1', 'pubrel 1', 'publish b qos 2 id 2']);
  connection.deliver(pubrec(2));
  await settle();
  connection.deliver(pubcomp(2));
  await second;
  await session.disconnect();
});

test('disconnect() drains a QoS 2 exchange through PUBREL and PUBCOMP before DISCONNECT', async () => {
  const { session, connection, sent } = await publisher();
  const publishing = session.publish('a', 'hi', qosTwo);
  await settle();
  const closing = session.disconnect();
  await expect(session.publish('b', 'late', qosTwo)).rejects.toMatchObject({ code: 'ERR_MQTT_CLOSING' });
  await settle();
  expect(sent()).toEqual(['publish a qos 2 id 1']);
  connection.deliver(pubrec(9));
  connection.deliver(pubrec(1));
  await settle();
  expect(sent()).toEqual(['publish a qos 2 id 1', 'pubrel 1']);
  connection.deliver(pubcomp(1));
  await expect(publishing).resolves.toBeUndefined();
  await closing;
  expect(sent()).toEqual(['publish a qos 2 id 1', 'pubrel 1', 'disconnect']);
});

test('a drain deadline rejects a QoS 2 publication without PUBCOMP, and nothing follows DISCONNECT', async () => {
  vi.useFakeTimers();
  const { session, connection, sent } = await publisher({}, { timeoutMs: 1000 });
  const released = session.publish('a', 'one', qosTwo).catch((error: unknown) => error);
  const unanswered = session.publish('b', 'two', qosTwo).catch((error: unknown) => error);
  await settle();
  connection.deliver(pubrec(1));
  await settle();
  const closing = session.disconnect({ drainTimeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  const expired = { code: 'ERR_MQTT_TIMEOUT', message: 'MQTT publish drain expired. Delivery outcome is unknown' };
  await expect(released).resolves.toMatchObject(expired);
  await expect(unanswered).resolves.toMatchObject(expired);
  await closing;
  connection.deliver(pubrec(2));
  connection.deliver(pubcomp(1));
  await settle();
  expect(sent()).toEqual(['publish a qos 2 id 1', 'publish b qos 2 id 2', 'pubrel 1', 'disconnect']);
  expect(vi.getTimerCount()).toBe(0);
});

test('a drain deadline rejects a publication whose PUBLISH write is still pending after PUBREC and PUBREL', async () => {
  vi.useFakeTimers();
  const { session, connection, sent, releaseWrites } = await publisher(
    { hold: (packet) => packet.cmd === 'publish' },
    { timeoutMs: 1000 },
  );
  const publishing = session.publish('a', 'hi', qosTwo).catch((error: unknown) => error);
  await settle();
  connection.deliver(pubrec(1));
  await settle();
  const closing = session.disconnect({ drainTimeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  await expect(publishing).resolves.toMatchObject({ code: 'ERR_MQTT_TIMEOUT' });
  releaseWrites();
  await closing;
  await settle();
  expect(sent()).toEqual(['publish a qos 2 id 1', 'pubrel 1', 'disconnect']);
  expect(vi.getTimerCount()).toBe(0);
});

test('a PUBREC that arrives while DISCONNECT is being written gets no PUBREL', async () => {
  const { session, connection, sent, releaseWrites } = await publisher({ hold: (packet) => packet.cmd === 'disconnect' });
  const publishing = session.publish('a', 'hi', qosTwo).catch((error: unknown) => error);
  await settle();
  const closing = session.disconnect({ drain: false });
  await settle();
  connection.deliver(pubrec(1));
  connection.deliver(pubrec(9));
  await settle();
  releaseWrites();
  await closing;
  await expect(publishing).resolves.toMatchObject({ code: 'ERR_MQTT_CLOSING' });
  expect(sent()).toEqual(['publish a qos 2 id 1', 'disconnect']);
});

test('a session end reports each written publication with its QoS and whether the broker accepted it', async () => {
  const { session, connection, ends } = await publisher();
  const publications = [
    session.publish('released', '1', qosTwo),
    session.publish('unanswered', '2', qosTwo),
    session.publish('once', '3', qosOne),
  ].map(async (publishing: Readonly<Promise<void>>) => publishing.catch((error: unknown) => error));
  await settle();
  connection.deliver(pubrec(1));
  await settle();
  connection.end();
  await Promise.all(publications);
  await settle();
  expect(ends).toHaveLength(1);
  expect(ends[0]).toMatchObject({
    kind: 'error',
    uncertain: [
      { topic: 'released', messageId: 1, qos: 2, acknowledged: true },
      { topic: 'unanswered', messageId: 2, qos: 2, acknowledged: false },
      { topic: 'once', messageId: 3, qos: 1, acknowledged: false },
    ],
  });
  await expect(session.ping()).rejects.toMatchObject({ code: 'ERR_MQTT_TRANSPORT' });
});

test('a refused PUBREC whose PUBLISH write is pending is reported as not acknowledged', async () => {
  const { connection, session, ends } = await publisher({ hold: (packet) => packet.cmd === 'publish' });
  const publishing = session.publish('a', 'hi', qosTwo).catch((error: unknown) => error);
  await settle();
  connection.deliver(pubrec(1, 0x80));
  await settle();
  connection.end();
  await publishing;
  await settle();
  expect(ends[0]).toMatchObject({ uncertain: [{ topic: 'a', messageId: 1, qos: 2, acknowledged: false }] });
});

test('an accepting PUBREC after a refusing one changes nothing while the PUBLISH write is pending', async () => {
  const { connection, session, sent, releaseWrites } = await publisher({ hold: (packet) => packet.cmd === 'publish' });
  const publishing = session.publish('a', 'hi', qosTwo).catch((error: unknown) => error);
  await settle();
  connection.deliver(pubrec(1, 0x80));
  connection.deliver(pubrec(1));
  await settle();
  releaseWrites();
  await expect(publishing).resolves.toMatchObject({ code: 'ERR_MQTT_REFUSED', reasonCode: 0x80 });
  expect(sent()).toEqual(['publish a qos 2 id 1']);
  await session.disconnect();
});

test('each step of a QoS 2 exchange has its own operation deadline', async () => {
  vi.useFakeTimers();
  const { session, connection, ends } = await publisher({}, { timeoutMs: 50 });
  const publishing = session.publish('a', 'hi', qosTwo).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30);
  connection.deliver(pubrec(1));
  await vi.advanceTimersByTimeAsync(40);
  expect(ends).toEqual([]);
  await vi.advanceTimersByTimeAsync(10);
  await expect(publishing).resolves.toMatchObject({ code: 'ERR_MQTT_TIMEOUT', message: 'MQTT operation timed out' });
  expect(ends).toMatchObject([{ kind: 'error', uncertain: [{ topic: 'a', messageId: 1, qos: 2, acknowledged: true }] }]);
  await expect(session.ping()).rejects.toMatchObject({ code: 'ERR_MQTT_TIMEOUT' });
});

test('a QoS 2 PUBLISH that the write budget refuses leaves the session usable and the session state empty', async () => {
  let buffered = 0;
  const sessionState = createSessionState();
  const { session, sent } = await publisher(
    { answer: acknowledge, buffered: () => buffered },
    { maxBufferedBytes: 64, reservedControlBytes: 16, sessionState },
  );
  buffered = 48;
  await expect(session.publish('a', 'hi', qosTwo)).rejects.toThrow('write budget exceeded');
  expect(sessionState.inFlight).toEqual([]);
  buffered = 0;
  await session.publish('b', 'hi', qosTwo);
  expect(sent()).toEqual(['publish b qos 2 id 2', 'pubrel 2']);
  await session.disconnect();
});
