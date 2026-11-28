import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createSessionState, createTransportClient, type ClientSession, type SessionEnd } from '../src/portableClient.js';
import { exchangeBroker, settle } from './experiments/exchange-broker.js';

// A seeded random walk of a conforming broker against the inbound QoS 2 path. The broker sends one message at a time,
// because the client advertises Receive Maximum 1, and always uses Packet Identifier 1. After a resume it sends the
// PUBLISH or the PUBREL again, whichever its exchange waits for, and after Session Present false it has forgotten the
// exchange. Handlers return at once or settle at a random later step, also after their connection ended. Connections
// drop and disconnect at random steps.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Mulberry32, so a seed names one walk. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Call {
  readonly message: number;
  state: 'pending' | 'fulfilled' | 'rejected';
  readonly resolve: () => void;
  readonly reject: (error: Readonly<Error>) => void;
}

interface Outcome {
  /** Each broken invariant, followed by the trace of the walk when there is one. */
  readonly violations: readonly string[];
  /** The messages whose exchange the broker finished. */
  readonly completed: number;
  readonly calls: number;
  /** The handler calls that started while another call was pending. */
  readonly concurrent: number;
  /** The duplicates that arrived while the handler of an earlier connection was pending. */
  readonly held: number;
}

async function walk(seed: number, steps: number, mayLoseSession: boolean): Promise<Outcome> {
  const next = random(seed);
  const trace: string[] = [];
  const violations: string[] = [];
  let sessionPresent = false;
  const peer = exchangeBroker({ connack: () => ({ sessionPresent }) });
  const sessionState = createSessionState();
  const ends: SessionEnd[] = [];
  const calls: Call[] = [];
  let connection = -1;
  let session: ClientSession | undefined;
  let seenEnds = 0;
  let cursor = 0;
  let concurrent = 0;
  let held = 0;
  let nextMessage = 1;
  // The one exchange the broker has open, and the packet it waits to have answered.
  let open: { readonly message: number; awaits: 'pubrec' | 'pubcomp' } | undefined;
  const completed = new Set<number>();
  const has = (message: number | undefined, ...states: readonly Call['state'][]): boolean =>
    calls.some((call: Readonly<Call>) => call.message === message && states.includes(call.state));
  const name = (message: number | undefined): string => 'm' + String(message);

  const connect = async (cleanStart: boolean): Promise<void> => {
    connection += 1;
    cursor = 0;
    const mine = connection;
    session = await createTransportClient(peer.transport, {
      clientId: 'fuzz',
      cleanStart,
      sessionExpiryInterval: 60,
      sessionState,
      onQosOneMessage() {},
      async onQosTwoMessage({ topic, dup }: Readonly<{ topic: string; dup: boolean }>) {
        const message = Number(topic.slice(1));
        // No handler may run twice at once for the same delivery, and none may run again after it fulfilled.
        if (has(message, 'pending', 'fulfilled'))
          violations.push(`a second handler call for ${topic} while an earlier call is pending or fulfilled`);
        if (calls.some((call: Readonly<Call>) => call.state === 'pending')) concurrent += 1;
        trace.push(`c${String(mine)} handler ${topic}${dup ? ' dup' : ''}`);
        if (next() < 0.35) {
          calls.push({ message, state: 'fulfilled', resolve() {}, reject() {} });
          return;
        }
        await new Promise<void>((resolve, reject) => {
          calls.push({ message, state: 'pending', resolve, reject });
        });
      },
      onSessionEnd(event) {
        ends.push(event);
      },
    }).connect();
    trace.push(`c${String(mine)} connected, Session Present ${String(sessionPresent)}`);
  };

  const sendPublish = (dup: boolean): void => {
    if (open === undefined) return;
    if (dup && has(open.message, 'pending')) held += 1;
    trace.push(`broker PUBLISH ${name(open.message)}${dup ? ' dup' : ''}`);
    peer.connection(connection).deliver({ cmd: 'publish', topic: name(open.message), payload: 'x', qos: 2, messageId: 1, dup });
  };

  const live = (): boolean => ends.length === seenEnds;

  /** Let the client work, read what it wrote, and answer as the broker. */
  const pump = async (): Promise<void> => {
    for (let round = 0; round < 12; round++) {
      await settle();
      if (!live()) return;
      const { frames } = peer.connection(connection);
      if (cursor >= frames.length) {
        if (open !== undefined) return;
        open = { message: nextMessage++, awaits: 'pubrec' };
        sendPublish(false);
        continue;
      }
      while (cursor < frames.length) {
        const frame = frames[cursor++] ?? [];
        const type = (frame[0] ?? 0) >> 4;
        if (type === 5) {
          trace.push('client PUBREC');
          // An acknowledged message has a fulfilled handler call.
          if (!has(open?.message, 'fulfilled'))
            violations.push(`PUBREC for ${name(open?.message)} without a fulfilled handler call`);
          if (open?.awaits === 'pubrec') {
            open.awaits = 'pubcomp';
            trace.push('broker PUBREL');
            peer.connection(connection).deliver({ cmd: 'pubrel', messageId: 1, reasonCode: 0 });
          }
        } else if (type === 7) {
          const reason = frame[4] ?? 0;
          trace.push(`client PUBCOMP ${String(reason)}`);
          if (open?.awaits !== 'pubcomp') violations.push('PUBCOMP without a PUBREL');
          else {
            if (reason !== 0) violations.push(`PUBCOMP with reason ${String(reason)} for ${name(open.message)}`);
            completed.add(open.message);
            open = undefined;
          }
        } else if (type === 14) {
          const reason = frame[2] ?? 0;
          trace.push(`client DISCONNECT ${String(reason)}`);
          if (reason >= 0x80) violations.push(`the client sent DISCONNECT 0x${reason.toString(16)} to a conforming broker`);
        }
      }
    }
  };

  const reconnect = async (): Promise<void> => {
    await settle();
    seenEnds = ends.length;
    sessionPresent = !mayLoseSession || next() < 0.8;
    // A broker that lost the session forgot its open exchange, and that message is gone.
    if (!sessionPresent) open = undefined;
    await connect(false);
    await settle();
    if (open?.awaits === 'pubrec') sendPublish(true);
    else if (open?.awaits === 'pubcomp') {
      trace.push('broker PUBREL again');
      peer.connection(connection).deliver({ cmd: 'pubrel', messageId: 1, reasonCode: 0 });
    }
  };

  await connect(true);
  for (let step = 0; step < steps; step++) {
    await pump();
    if (!live()) {
      await reconnect();
      continue;
    }
    const pending = calls.filter((call: Readonly<Call>) => call.state === 'pending');
    const chosen = pending[Math.floor(next() * pending.length)];
    const choice = next();
    if (choice < 0.3 && chosen !== undefined) {
      trace.push(`a handler of ${name(chosen.message)} fulfills`);
      chosen.state = 'fulfilled';
      chosen.resolve();
    } else if (choice < 0.55 && chosen !== undefined) {
      trace.push(`a handler of ${name(chosen.message)} fails`);
      chosen.state = 'rejected';
      chosen.reject(new Error('handler failed'));
    } else if (choice < 0.8) {
      trace.push(`c${String(connection)} drops`);
      peer.connection(connection).end();
      await settle();
      await reconnect();
    } else if (choice < 0.85) {
      trace.push(`c${String(connection)} disconnect()`);
      await session?.disconnect().catch(() => {});
      await settle();
      await reconnect();
    }
  }
  // Every handler that still runs fails, so a finished exchange without a fulfilled call is a lost message.
  for (const call of calls) {
    if (call.state !== 'pending') continue;
    call.state = 'rejected';
    call.reject(new Error('handler failed at the end'));
  }
  await settle();
  for (const message of completed) if (!has(message, 'fulfilled')) violations.push(`${name(message)} is lost`);
  for (const end of ends)
    if (end.kind === 'error' && /Receive Maximum|PUBREL arrived/v.test(end.error.message))
      violations.push(`a session ended with ${end.error.message}`);
  await session?.disconnect().catch(() => {});
  return {
    violations: violations.length === 0 ? violations : [...violations, ...trace],
    completed: completed.size,
    calls: calls.length,
    concurrent,
    held,
  };
}

// Two handlers run at once only after the broker lost the session, when the older one belongs to a forgotten message.
test.each([
  ['never loses the session', false, 0],
  ['may lose the session', true, Number.POSITIVE_INFINITY],
] as const)(
  'inbound QoS 2 loses and repeats no message against a conforming broker that %s',
  async (_name, mayLoseSession, concurrentLimit) => {
    const violations: (readonly string[])[] = [];
    const totals = { completed: 0, calls: 0, concurrent: 0, held: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const outcome = await walk(seed * 7919 + (mayLoseSession ? 1 : 0), 50, mayLoseSession);
      if (outcome.violations.length > 0) violations.push(outcome.violations);
      totals.completed += outcome.completed;
      totals.calls += outcome.calls;
      totals.concurrent += outcome.concurrent;
      totals.held += outcome.held;
    }
    expect(violations).toEqual([]);
    // The walks reach the cases they are for: finished exchanges, and duplicates that wait for an earlier handler.
    expect(totals.completed).toBeGreaterThan(1000);
    expect(totals.held).toBeGreaterThan(100);
    expect(totals.concurrent).toBeLessThanOrEqual(concurrentLimit);
  },
);

test('a seed names one walk', async () => {
  expect(await walk(7919, 50, true)).toEqual(await walk(7919, 50, true));
});
