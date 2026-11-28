import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createSessionState,
  createTransportClient,
  type ByteClientOptions,
  type ClientSession,
  type SessionEnd,
} from '../src/portableClient.js';
import { acknowledge, exchangeBroker, settle, type Delivery, type ExchangeScript } from './experiments/exchange-broker.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

function message(topic: string, messageId: number, dup = false): Delivery {
  return { cmd: 'publish', topic, payload: topic, qos: 2, messageId, dup };
}

function pubrel(messageId: number): Delivery {
  return { cmd: 'pubrel', messageId, reasonCode: 0 };
}

const pubrecOne = [0x50, 2, 0, 1];
const pubcompOne = [0x70, 2, 0, 1];
const pubrecTwo = [0x50, 2, 0, 2];

type Options = Readonly<Pick<ByteClientOptions, 'cleanStart' | 'timeoutMs' | 'onMessage'>>;

/**
 * One session state, a broker that answers Session Present true from the second connection on, and a QoS 2 handler whose
 * calls stay pending until the test settles them. `calls` lists each call as its topic, with ` dup` when DUP is set, and
 * `settle.fulfill` and `settle.fail` take the topic of the oldest pending call.
 */
function setup(script: Readonly<ExchangeScript> = {}) {
  const peer = exchangeBroker({ connack: (index) => ({ sessionPresent: index >= 2 }), ...script });
  const sessionState = createSessionState();
  const calls: string[] = [];
  const pending: Readonly<{ topic: string; resolve: () => void; reject: (reason: Readonly<Error>) => void }>[] = [];
  const ends: SessionEnd[][] = [];
  const take = (topic: string) => {
    const index = pending.findIndex((call) => call.topic === topic);
    const [call] = index === -1 ? [] : pending.splice(index, 1);
    if (call === undefined) throw new Error('No pending handler call for ' + topic);
    return call;
  };
  const connect = async (options: Options = {}): Promise<ClientSession> => {
    const mine: SessionEnd[] = [];
    ends.push(mine);
    return createTransportClient(peer.transport, {
      clientId: 'receiver',
      sessionExpiryInterval: 60,
      sessionState,
      cleanStart: ends.length === 1,
      onQosOneMessage() {},
      async onQosTwoMessage({ topic, dup }: Readonly<{ topic: string; dup: boolean }>) {
        calls.push(topic + (dup ? ' dup' : ''));
        await new Promise<void>((resolve, reject) => {
          pending.push({ topic, resolve, reject });
        });
      },
      onSessionEnd(event) {
        mine.push(event);
      },
      ...options,
    }).connect();
  };
  /** Connect, deliver message A with Packet Identifier 1, and end the connection while its handler runs. */
  const interrupted = async (options: Options = {}): Promise<void> => {
    await connect(options);
    peer.connection(0).deliver(message('A', 1));
    await settle();
    peer.connection(0).end();
    await settle();
  };
  return {
    peer,
    calls,
    ends,
    connect,
    interrupted,
    fulfill: (topic: string): void => {
      take(topic).resolve();
    },
    fail: (topic: string): void => {
      take(topic).reject(new Error(topic + ' failed'));
    },
  };
}

test('the duplicate of a publication whose handler an earlier connection started gets PUBREC when that handler fulfills', async () => {
  const { peer, calls, ends, connect, interrupted, fulfill } = setup();
  await interrupted();
  const session = await connect();
  const second = peer.connection(1);
  second.deliver(message('A', 1, true));
  await settle();
  expect(second.frames).toEqual([]);
  // Control packets and the session do not wait for the handler.
  await session.ping();
  fulfill('A');
  await settle();
  expect(second.frames).toEqual([[0xc0, 0], pubrecOne]);
  expect(peer.connection(0).frames).toEqual([]);
  second.deliver(pubrel(1));
  await settle();
  // The exchange ended, so the broker may give Packet Identifier 1 to a new message.
  second.deliver(message('B', 1));
  await settle();
  fulfill('B');
  await settle();
  expect(second.frames).toEqual([[0xc0, 0], pubrecOne, pubcompOne, pubrecOne]);
  expect(calls).toEqual(['A', 'B']);
  expect(ends[1]).toEqual([]);
  await session.disconnect();
});

test('the duplicate reaches the handler again, with dup true, when the handler of the earlier connection fails', async () => {
  const unhandled = vi.fn<(reason: unknown) => void>();
  process.on('unhandledRejection', unhandled);
  try {
    const { peer, calls, ends, connect, interrupted, fulfill, fail } = setup();
    await interrupted();
    const session = await connect();
    const second = peer.connection(1);
    second.deliver(message('A', 1, true));
    await settle();
    fail('A');
    await settle();
    expect(calls).toEqual(['A', 'A dup']);
    expect(second.frames).toEqual([]);
    expect(ends[1]).toEqual([]);
    fulfill('A');
    await settle();
    expect(second.frames).toEqual([pubrecOne]);
    second.deliver(pubrel(1));
    await settle();
    expect(second.frames).toEqual([pubrecOne, pubcompOne]);
    expect(calls).toEqual(['A', 'A dup']);
    await session.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

test('a second failure ends the session without PUBREC, and the next resumed session delivers the publication again', async () => {
  const { peer, calls, ends, connect, interrupted, fulfill, fail } = setup();
  await interrupted();
  await connect();
  peer.connection(1).deliver(message('A', 1, true));
  await settle();
  fail('A');
  await settle();
  fail('A');
  await settle();
  expect(peer.connection(1).frames).toEqual([]);
  expect(ends[1]).toMatchObject([{ kind: 'error', error: { message: 'A failed' } }]);
  const third = await connect();
  peer.connection(2).deliver(message('A', 1, true));
  await settle();
  fulfill('A');
  await settle();
  expect(calls).toEqual(['A', 'A dup', 'A dup']);
  expect(peer.connection(2).frames).toEqual([pubrecOne]);
  await third.disconnect();
});

test('the operation deadline covers the wait for the handler of the earlier connection', async () => {
  const { peer, calls, ends, connect, interrupted, fulfill } = setup();
  await interrupted({ timeoutMs: 50 });
  await connect({ timeoutMs: 50 });
  const second = peer.connection(1);
  await vi.advanceTimersByTimeAsync(30);
  second.deliver(message('A', 1, true));
  await vi.advanceTimersByTimeAsync(49);
  expect(ends[1]).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(ends[1]).toMatchObject([{ kind: 'error', error: { code: 'ERR_MQTT_TIMEOUT', message: 'MQTT operation timed out' } }]);
  // The transport closes without DISCONNECT, as for a handler that outlasts the deadline on its own connection.
  expect(second.frames).toEqual([]);
  expect(second.closes).toEqual([true]);
  // The next resumed session starts over, and the handler that still runs answers its duplicate.
  const third = await connect({ timeoutMs: 50 });
  peer.connection(2).deliver(message('A', 1, true));
  await settle();
  fulfill('A');
  await settle();
  expect(peer.connection(2).frames).toEqual([pubrecOne]);
  expect(second.frames).toEqual([]);
  expect(calls).toEqual(['A']);
  await third.disconnect();
});

test('a handler call that follows a failed earlier handler gets its own operation deadline', async () => {
  const { peer, calls, ends, connect, interrupted, fulfill, fail } = setup();
  await interrupted({ timeoutMs: 50 });
  const session = await connect({ timeoutMs: 50 });
  peer.connection(1).deliver(message('A', 1, true));
  await vi.advanceTimersByTimeAsync(40);
  fail('A');
  await vi.advanceTimersByTimeAsync(40);
  expect(ends[1]).toEqual([]);
  expect(calls).toEqual(['A', 'A dup']);
  fulfill('A');
  await vi.advanceTimersByTimeAsync(0);
  expect(peer.connection(1).frames).toEqual([pubrecOne]);
  await session.disconnect();
});

test('a QoS 0 PUBLISH still flows while the PUBREC is held, and a second duplicate changes nothing', async () => {
  const onMessage = vi.fn<(message: Readonly<{ topic: string }>) => void>();
  const { peer, calls, ends, connect, interrupted, fulfill } = setup();
  await interrupted();
  const session = await connect({ onMessage });
  const second = peer.connection(1);
  second.deliver(message('A', 1, true));
  await settle();
  second.deliver({ cmd: 'publish', topic: 'zero', payload: 'x' });
  second.deliver(message('A', 1, true));
  await settle();
  expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topic: 'zero' }));
  expect(second.frames).toEqual([]);
  expect(ends[1]).toEqual([]);
  fulfill('A');
  await settle();
  expect(second.frames).toEqual([pubrecOne]);
  expect(calls).toEqual(['A']);
  await session.disconnect();
});

test('a PUBLISH without DUP on the connection that holds the PUBREC of its identifier is still a duplicate', async () => {
  const { peer, calls, ends, connect, interrupted, fulfill } = setup();
  await interrupted();
  const session = await connect();
  const second = peer.connection(1);
  second.deliver(message('A', 1, true));
  await settle();
  // A session cannot change within one connection, so this PUBLISH repeats the one that holds the slot.
  second.deliver(message('A', 1, false));
  await settle();
  expect(calls).toEqual(['A']);
  expect(ends[1]).toEqual([]);
  fulfill('A');
  await settle();
  expect(second.frames).toEqual([pubrecOne]);
  await session.disconnect();
});

test.each(['fulfills', 'fails'] as const)(
  'a PUBLISH without DUP is a new message while the handler of an earlier connection runs for its identifier, and that handler %s later',
  async (outcome) => {
    const { peer, calls, ends, connect, interrupted, fulfill, fail } = setup();
    await interrupted();
    const session = await connect();
    const second = peer.connection(1);
    // The broker sets DUP when it sends a PUBLISH again (MQTT-3.3.1-1), so this one is a message of a broker session
    // that replaced the one the client remembers. It does not wait for the handler of A.
    second.deliver(message('B', 1, false));
    await settle();
    expect(calls).toEqual(['A', 'B']);
    expect(second.frames).toEqual([]);
    if (outcome === 'fulfills') fulfill('A');
    else fail('A');
    await settle();
    expect(calls).toEqual(['A', 'B']);
    expect(second.frames).toEqual([]);
    fulfill('B');
    await settle();
    second.deliver(pubrel(1));
    await settle();
    expect(second.frames).toEqual([pubrecOne, pubcompOne]);
    expect(ends[1]).toEqual([]);
    await session.disconnect();
  },
);

test.each([
  ['QoS 1', { cmd: 'publish', topic: 'B', payload: 'B', qos: 1, messageId: 2 }],
  ['QoS 2', { cmd: 'publish', topic: 'B', payload: 'B', qos: 2, messageId: 2 }],
] as const)('a %s PUBLISH while the PUBREC is held exceeds the Receive Maximum', async (_name, next) => {
  const { peer, calls, ends, connect, interrupted } = setup();
  await interrupted();
  await connect();
  const second = peer.connection(1);
  second.deliver(message('A', 1, true));
  await settle();
  second.deliver(next);
  await settle();
  expect(second.frames).toEqual([[0xe0, 1, 0x93]]);
  expect(ends[1]).toMatchObject([{ kind: 'error', error: { code: 'ERR_MQTT_PROTOCOL', reasonCode: 0x93 } }]);
  expect(calls).toEqual(['A']);
});

test('a PUBREL while the PUBREC is held is a protocol error with reason 0x82', async () => {
  const { peer, ends, connect, interrupted, fulfill } = setup();
  await interrupted();
  await connect();
  const second = peer.connection(1);
  second.deliver(message('A', 1, true));
  await settle();
  second.deliver(pubrel(1));
  await settle();
  expect(second.frames).toEqual([[0xe0, 1, 0x82]]);
  expect(ends[1]).toMatchObject([{ kind: 'error', error: { reasonCode: 0x82, message: 'MQTT PUBREL arrived before PUBREC' } }]);
  // The publication stays recorded, so the handler that still runs answers the next duplicate.
  const third = await connect();
  peer.connection(2).deliver(message('A', 1, true));
  await settle();
  fulfill('A');
  await settle();
  expect(peer.connection(2).frames).toEqual([pubrecOne]);
  await third.disconnect();
});

test('a PUBREL for a publication whose handler an earlier connection started is a protocol error without the duplicate too', async () => {
  const { peer, calls, ends, connect, interrupted, fail } = setup();
  await interrupted();
  await connect();
  const second = peer.connection(1);
  second.deliver(pubrel(1));
  await settle();
  expect(second.frames).toEqual([[0xe0, 1, 0x82]]);
  expect(ends[1]).toMatchObject([{ kind: 'error', error: { reasonCode: 0x82, message: 'MQTT PUBREL arrived before PUBREC' } }]);
  // No PUBCOMP ended the exchange, so the publication is not lost when its handler fails afterwards.
  fail('A');
  await settle();
  const third = await connect();
  peer.connection(2).deliver(message('A', 1, true));
  await settle();
  expect(calls).toEqual(['A', 'A dup']);
  await third.disconnect();
});

test('a duplicate in one chunk with the CONNACK of the resumed session waits for the earlier handler', async () => {
  const { peer, calls, connect, interrupted, fulfill } = setup({
    answer: (packet, index) => (index === 2 && packet.cmd === 'connect' ? [message('A', 1, true)] : undefined),
  });
  await interrupted();
  const session = await connect();
  await settle();
  expect(peer.connection(1).frames).toEqual([]);
  fulfill('A');
  await settle();
  expect(peer.connection(1).frames).toEqual([pubrecOne]);
  expect(calls).toEqual(['A']);
  await session.disconnect();
});

test('a connection that ends while it holds the PUBREC writes nothing later, and the next resumed session starts over', async () => {
  const { peer, calls, ends, connect, interrupted, fulfill } = setup();
  await interrupted();
  await connect();
  peer.connection(1).deliver(message('A', 1, true));
  await settle();
  peer.connection(1).end();
  await settle();
  expect(ends[1]).toMatchObject([{ kind: 'error', error: { code: 'ERR_MQTT_TRANSPORT' } }]);
  const third = await connect();
  peer.connection(2).deliver(message('A', 1, true));
  await settle();
  expect(peer.connection(2).frames).toEqual([]);
  fulfill('A');
  await settle();
  expect(peer.connection(1).frames).toEqual([]);
  expect(peer.connection(2).frames).toEqual([pubrecOne]);
  expect(calls).toEqual(['A']);
  await third.disconnect();
});

test('a connection that ended while it held the PUBREC calls no handler when the earlier handler fails afterwards', async () => {
  const { peer, calls, connect, interrupted, fulfill, fail } = setup();
  await interrupted();
  await connect();
  peer.connection(1).deliver(message('A', 1, true));
  await settle();
  peer.connection(1).end();
  await settle();
  fail('A');
  await settle();
  expect(calls).toEqual(['A']);
  const third = await connect();
  peer.connection(2).deliver(message('A', 1, true));
  await settle();
  expect(calls).toEqual(['A', 'A dup']);
  fulfill('A');
  await settle();
  expect(peer.connection(1).frames).toEqual([]);
  expect(peer.connection(2).frames).toEqual([pubrecOne]);
  await third.disconnect();
});

test.each(['fulfills', 'fails'] as const)(
  'disconnect() while the PUBREC is held writes no PUBREC and calls no handler when the earlier handler %s afterwards',
  async (outcome) => {
    const { peer, calls, connect, interrupted, fulfill, fail } = setup();
    await interrupted();
    const session = await connect();
    const second = peer.connection(1);
    second.deliver(message('A', 1, true));
    await settle();
    await session.disconnect();
    if (outcome === 'fulfills') fulfill('A');
    else fail('A');
    await settle();
    expect(second.frames).toEqual([[0xe0, 0]]);
    expect(calls).toEqual(['A']);
    const third = await connect();
    peer.connection(2).deliver(message('A', 1, true));
    await settle();
    // A fulfilled handler answers the duplicate at once. A failed one leaves the publication to the new connection.
    expect(calls).toEqual(outcome === 'fulfills' ? ['A'] : ['A', 'A dup']);
    expect(peer.connection(2).frames).toEqual(outcome === 'fulfills' ? [pubrecOne] : []);
    await third.disconnect();
  },
);

test.each(['fulfills', 'fails'] as const)(
  'a disconnect() that still drains writes no PUBREC and calls no handler when the earlier handler %s',
  async (outcome) => {
    const { peer, calls, connect, interrupted, fulfill, fail } = setup({
      answer: (packet, index) => (index === 2 && packet.topic === 'drained' ? undefined : acknowledge(packet)),
    });
    await interrupted();
    const session = await connect();
    const second = peer.connection(1);
    second.deliver(message('A', 1, true));
    await settle();
    const publishing = session.publish('drained', 'x', { qos: 1 }).catch((reason: unknown) => reason);
    await settle();
    const closing = session.disconnect();
    await settle();
    if (outcome === 'fulfills') fulfill('A');
    else fail('A');
    await settle();
    expect(calls).toEqual(['A']);
    expect(second.frames.filter((frame: readonly number[]) => frame[0] === 0x50)).toEqual([]);
    second.deliver({ cmd: 'puback', messageId: 1, reasonCode: 0 });
    await closing;
    await publishing;
    expect(second.frames.at(-1)).toEqual([0xe0, 0]);
    expect(second.frames.filter((frame: readonly number[]) => frame[0] === 0x50)).toEqual([]);
    expect(calls).toEqual(['A']);
  },
);

test.each(['fulfills', 'fails'] as const)(
  'a handler that %s after a later connection got Session Present false changes nothing in the new session',
  async (outcome) => {
    const { peer, calls, ends, connect, interrupted, fulfill, fail } = setup({ connack: () => ({ sessionPresent: false }) });
    await interrupted();
    const session = await connect();
    const second = peer.connection(1);
    // The new broker session counts its Packet Identifiers from 1 again, so B is a new message and not a duplicate.
    second.deliver(message('B', 1));
    await settle();
    expect(calls).toEqual(['A', 'B']);
    if (outcome === 'fulfills') fulfill('A');
    else fail('A');
    await settle();
    expect(second.frames).toEqual([]);
    fulfill('B');
    await settle();
    second.deliver(pubrel(1));
    await settle();
    second.deliver(message('C', 1));
    await settle();
    fulfill('C');
    await settle();
    expect(second.frames).toEqual([pubrecOne, pubcompOne, pubrecOne]);
    expect(calls).toEqual(['A', 'B', 'C']);
    expect(ends[1]).toEqual([]);
    await session.disconnect();
  },
);

test.each(['fulfills', 'fails'] as const)(
  'a handler that %s after the last connection ended writes nothing and leaves no unhandled rejection',
  async (outcome) => {
    const unhandled = vi.fn<(reason: unknown) => void>();
    process.on('unhandledRejection', unhandled);
    try {
      const { peer, calls, connect, interrupted, fulfill, fail } = setup();
      await interrupted();
      await connect();
      peer.connection(1).deliver(message('A', 1, true));
      await settle();
      peer.connection(1).end();
      await settle();
      if (outcome === 'fulfills') fulfill('A');
      else fail('A');
      await settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(peer.connection(0).frames).toEqual([]);
      expect(peer.connection(1).frames).toEqual([]);
      expect(calls).toEqual(['A']);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  },
);

test.each(['fulfills', 'fails'] as const)(
  'a connection that waits for one handler does nothing when the handler of another publication %s',
  async (outcome) => {
    const { peer, calls, ends, connect, interrupted, fulfill, fail } = setup();
    await interrupted();
    // This broker starts message B without sending A again, so two handlers of two connections run.
    await connect();
    peer.connection(1).deliver(message('B', 2));
    await settle();
    peer.connection(1).end();
    await settle();
    const session = await connect();
    const third = peer.connection(2);
    third.deliver(message('B', 2, true));
    await settle();
    if (outcome === 'fulfills') fulfill('A');
    else fail('A');
    await settle();
    expect(third.frames).toEqual([]);
    expect(calls).toEqual(['A', 'B']);
    fulfill('B');
    await settle();
    expect(third.frames).toEqual([pubrecTwo]);
    third.deliver(pubrel(2));
    await settle();
    // The handler of A settled while the connection waited for B. Its duplicate gets PUBREC at once when it fulfilled,
    // and reaches the handler again when it failed.
    third.deliver(message('A', 1, true));
    await settle();
    expect(calls).toEqual(outcome === 'fulfills' ? ['A', 'B'] : ['A', 'B', 'A dup']);
    expect(third.frames).toEqual(outcome === 'fulfills' ? [pubrecTwo, [0x70, 2, 0, 2], pubrecOne] : [pubrecTwo, [0x70, 2, 0, 2]]);
    expect(ends[2]).toEqual([]);
    await session.disconnect();
  },
);

// The PUBLISH arrives a given number of microtask turns after the earlier handler failed, so one of the cases meets every
// step between the failure and the second handler call.
test.each(Array.from({ length: 16 }, (_, turns) => turns))(
  'a second duplicate %i microtask turns after the earlier handler failed starts no third handler call',
  async (turns) => {
    const { peer, calls, ends, connect, interrupted, fulfill, fail } = setup();
    await interrupted();
    const session = await connect();
    const second = peer.connection(1);
    second.deliver(message('A', 1, true));
    await settle();
    fail('A');
    for (let turn = 0; turn < turns; turn++) await Promise.resolve();
    second.deliver(message('A', 1, true));
    await settle();
    expect(calls).toEqual(['A', 'A dup']);
    expect(ends[1]).toEqual([]);
    fulfill('A');
    await settle();
    expect(second.frames).toEqual([pubrecOne]);
    await session.disconnect();
  },
);
