import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { watchPageLifecycle, type PageLifecycleOptions, type PageReturn } from '../src/pageLifecycle.js';
import { createTransportClient, type ByteClientOptions } from '../src/portableClient.js';
import { createReconnectingClient, type ReconnectEvent, type ReconnectOptions } from '../src/reconnect.js';
import { broker } from './experiments/scripted-broker.js';

function page() {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  const added = [vi.spyOn(window, 'addEventListener'), vi.spyOn(document, 'addEventListener')];
  const removed = [vi.spyOn(window, 'removeEventListener'), vi.spyOn(document, 'removeEventListener')];
  const visibility = (state: 'hidden' | 'visible'): void => {
    document.visibilityState = state;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  return {
    hide() {
      visibility('hidden');
    },
    show() {
      visibility('visible');
    },
    freeze() {
      document.dispatchEvent(new Event('freeze'));
    },
    resume() {
      document.dispatchEvent(new Event('resume'));
    },
    pagehide(persisted: boolean) {
      window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));
    },
    pageshow(persisted: boolean) {
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
    },
    listening(): string[] {
      const active: string[] = [];
      for (const [index, spy] of added.entries()) {
        const removals = removed[index]?.mock.calls ?? [];
        for (const [type, listener] of spy.mock.calls) {
          let kept = true;
          for (const [removedType, removedListener] of removals)
            if (removedType === type && removedListener === listener) kept = false;
          if (kept) active.push(type);
        }
      }
      return active;
    },
  };
}

function watched(
  reconnect: Readonly<ReconnectOptions> = {},
  lifecycle: Readonly<PageLifecycleOptions> = {},
  factory: Readonly<{ timeoutMs?: number }> = {},
) {
  const peer = broker();
  const events: ReconnectEvent[] = [];
  const returns: PageReturn[] = [];
  const client = createReconnectingClient<ByteClientOptions>(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteClientOptions in src/transportCore.ts holds a native AbortSignal and Uint8Array callbacks, which createTransportClient keeps by identity.
    (options) => createTransportClient(peer.transport, options),
    { clientId: 'lifecycle', onQosOneMessage() {}, ...factory },
    {
      initialDelayMs: 1000,
      maxDelayMs: 1000,
      random: () => 0,
      ...reconnect,
      onReconnect(event) {
        events.push(event);
      },
    },
  );
  const view = page();
  const stop = watchPageLifecycle(client, {
    ...lifecycle,
    onReturn(event) {
      returns.push(event);
    },
  });
  const pings = (index: number) => peer.received(index).commands.filter((command) => command === 'pingreq').length;
  const silence = (index: number) => {
    const connection = peer.connections[index];
    if (connection !== undefined) connection.silent = true;
  };
  return { peer, client, events, returns, view, stop, pings, silence };
}

/**
 * Moves the monotonic clock and Date by `ms` as a frozen page sees it: no timer runs during the pause, and every timer
 * that came due runs once at its end, so a timer it arms counts from the end of the pause. This is clock.jump of
 * @sinonjs/fake-timers, which vitest installs and attaches to the faked setTimeout as its `clock` property. The jump runs
 * the overdue timers one after another in one task, while a browser runs each in its own task.
 */
function freezeFor(ms: number): void {
  const clock: unknown = Reflect.get(setTimeout, 'clock');
  const jump: unknown = typeof clock === 'object' && clock !== null ? Reflect.get(clock, 'jump') : undefined;
  if (typeof jump !== 'function') throw new Error('The fake clock has no jump');
  Reflect.apply(jump, clock, [ms]);
}

/**
 * Runs `fn` at the end of the next freezeFor, before the timers the client arms after this call. The fake clock runs
 * timers that come due at the same moment in the order they were created.
 */
function beforeOverdueTimers(fn: () => void): void {
  setTimeout(fn, 1);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a hidden page that becomes visible pings the session once', async () => {
  const { client, returns, view, stop, pings } = watched();
  await client.session();
  view.hide();
  await vi.advanceTimersByTimeAsync(5000);
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 5000, outcome: 'answered' }]);
  expect(pings(0)).toBe(1);
  stop();
  await client.disconnect();
});

test('a connection that went silent while hidden ends within timeoutMs, and the next attempt does not wait', async () => {
  const { peer, client, events, returns, view, stop, silence } = watched();
  const stale = await client.session();
  view.hide();
  await vi.advanceTimersByTimeAsync(60_000);
  silence(0);
  view.show();
  await vi.advanceTimersByTimeAsync(2999);
  expect(returns).toEqual([]);
  await expect(client.session()).resolves.toBe(stale);
  await vi.advanceTimersByTimeAsync(1);
  expect(peer.connections).toHaveLength(2);
  await expect(client.session()).resolves.not.toBe(stale);
  expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 60_000, outcome: 'retried' }]);
  expect(events).toMatchObject([
    { kind: 'connected', generation: 1 },
    { kind: 'retrying', attempt: 1, delayMs: 500, error: { code: 'ERR_MQTT_TIMEOUT' } },
    { kind: 'connected', generation: 2, previous: { kind: 'error', error: { code: 'ERR_MQTT_TIMEOUT' } } },
  ]);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(peer.connections).toHaveLength(2);
  stop();
  await client.disconnect();
});

test.each(['return first', 'overdue timers first'] as const)(
  'a ten-minute freeze while the client waits starts one attempt, %s',
  async (order) => {
    const { peer, client, events, returns, view, stop, pings } = watched({ initialDelayMs: 60_000, maxDelayMs: 60_000 });
    await client.session();
    const comeBack = () => {
      view.resume();
      view.show();
    };
    if (order === 'return first') beforeOverdueTimers(comeBack);
    view.hide();
    view.freeze();
    peer.connections[0]?.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toMatchObject({ kind: 'retrying', delayMs: 30_000 });
    const pausedAt = performance.now();
    freezeFor(600_000);
    expect(performance.now() - pausedAt).toBe(600_000);
    expect(peer.connections).toHaveLength(2);
    if (order === 'overdue timers first') {
      await client.session();
      comeBack();
    }
    await vi.advanceTimersByTimeAsync(0);
    await client.session();
    expect(returns).toEqual([
      { trigger: 'visibilitychange', awayMs: 600_000, outcome: order === 'return first' ? 'retried' : 'answered' },
    ]);
    expect(pings(1)).toBe(order === 'return first' ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(peer.connections).toHaveLength(2);
    expect(events.map((event) => event.kind)).toEqual(['connected', 'retrying', 'connected']);
    stop();
    await client.disconnect();
  },
);

test.each(['return first', 'overdue timers first'] as const)(
  'a publication pending through a ten-minute freeze rejects when the page runs again, and one attempt replaces the session, %s',
  async (order) => {
    const { peer, client, events, returns, view, stop, silence } = watched();
    const stale = await client.session();
    silence(0);
    const comeBack = () => {
      view.resume();
      view.show();
    };
    if (order === 'return first') beforeOverdueTimers(comeBack);
    const start = performance.now();
    const publication = stale.publish('sensor/1', 'pending', { qos: 1 }).then(
      () => ({ error: undefined, afterMs: performance.now() - start }),
      (error: unknown) => ({ error, afterMs: performance.now() - start }),
    );
    view.hide();
    view.freeze();
    freezeFor(600_000);
    await vi.advanceTimersByTimeAsync(0);
    if (order === 'overdue timers first') {
      comeBack();
      await vi.advanceTimersByTimeAsync(0);
    }
    await expect(publication).resolves.toMatchObject({ error: { code: 'ERR_MQTT_TIMEOUT' }, afterMs: 600_000 });
    expect(peer.connections).toHaveLength(2);
    await expect(client.session()).resolves.not.toBe(stale);
    expect(performance.now() - start).toBe(600_000);
    expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 600_000, outcome: 'retried' }]);
    expect(events.map((event) => event.kind)).toEqual(['connected', 'retrying', 'connected']);
    expect(events.at(-1)).toMatchObject({ previous: { uncertain: [{ topic: 'sensor/1', acknowledged: false }] } });
    expect(vi.getTimerCount()).toBe(0);
    stop();
    await client.disconnect();
  },
);

test('a restore from the back-forward cache in the Chromium event order runs one check with the whole absence', async () => {
  const { peer, client, returns, view, stop } = watched({ initialDelayMs: 60_000, maxDelayMs: 60_000 });
  await client.session();
  view.pageshow(false);
  view.pagehide(true);
  view.hide();
  view.freeze();
  freezeFor(60_000);
  view.resume();
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([]);
  view.show();
  view.pageshow(true);
  expect(peer.connections).toHaveLength(2);
  await client.session();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 60_000, outcome: 'retried' }]);
  stop();
  await client.disconnect();
});

test('pageshow with persisted true ends an absence that pagehide started on a visible page', async () => {
  const { client, returns, view, stop, pings } = watched();
  await client.session();
  view.pagehide(true);
  await vi.advanceTimersByTimeAsync(2000);
  view.pageshow(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'pageshow', awayMs: 2000, outcome: 'answered' }]);
  expect(pings(0)).toBe(1);
  stop();
  await client.disconnect();
});

test('repeated away and return events run one check', async () => {
  const { client, returns, view, stop, pings } = watched();
  await client.session();
  view.hide();
  view.pagehide(true);
  view.freeze();
  view.hide();
  await vi.advanceTimersByTimeAsync(1000);
  view.resume();
  view.show();
  view.resume();
  view.pageshow(true);
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 1000, outcome: 'answered' }]);
  expect(pings(0)).toBe(1);
  stop();
  await client.disconnect();
});

test('a return while a ping of an earlier return is pending sends no second ping', async () => {
  const { client, returns, view, stop, pings, silence } = watched();
  await client.session();
  silence(0);
  view.hide();
  view.show();
  view.hide();
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 0, outcome: 'skipped' }]);
  expect(pings(0)).toBe(1);
  stop();
  await client.disconnect();
});

test('a return while an attempt opens reports connecting at once and sends no ping', async () => {
  const peer = broker({ connack: (connection) => (connection === 2 ? undefined : 0) });
  const returns: PageReturn[] = [];
  const client = createReconnectingClient<ByteClientOptions>(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteClientOptions in src/transportCore.ts holds a native AbortSignal and Uint8Array callbacks, which createTransportClient keeps by identity.
    (options) => createTransportClient(peer.transport, options),
    { clientId: 'lifecycle' },
    { random: () => 0 },
  );
  const view = page();
  const stop = watchPageLifecycle(client, {
    onReturn(event) {
      returns.push(event);
    },
  });
  await client.session();
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(500);
  expect(peer.connections).toHaveLength(2);
  view.hide();
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 0, outcome: 'connecting' }]);
  expect(peer.received(1).commands).toEqual(['connect']);
  stop();
  await client.disconnect();
});

test('a client that stopped while the page was away reports stopped', async () => {
  const peer = broker({ connack: (connection) => (connection === 1 ? 0 : 0x88) });
  const returns: PageReturn[] = [];
  const client = createReconnectingClient<ByteClientOptions>(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteClientOptions in src/transportCore.ts holds a native AbortSignal and Uint8Array callbacks, which createTransportClient keeps by identity.
    (options) => createTransportClient(peer.transport, options),
    { clientId: 'lifecycle' },
    { random: () => 0, maxAttempts: 2 },
  );
  const view = page();
  const stop = watchPageLifecycle(client, {
    onReturn(event) {
      returns.push(event);
    },
  });
  await client.session();
  view.hide();
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(5000);
  await expect(client.session()).rejects.toMatchObject({ code: 'ERR_MQTT_REFUSED', reasonCode: 0x88 });
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 5000, outcome: 'stopped' }]);
  expect(peer.connections).toHaveLength(2);
  stop();
});

test('a return after a disconnect reports stopped and opens nothing', async () => {
  const { peer, client, returns, view, stop } = watched();
  await client.session();
  await client.disconnect();
  view.hide();
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 0, outcome: 'stopped' }]);
  expect(peer.connections).toHaveLength(1);
  stop();
});

test('a ping that a ping of the application holds back reports skipped and leaves the session', async () => {
  const { client, returns, view, stop, pings, silence } = watched();
  const session = await client.session();
  silence(0);
  const own = session.ping().catch((error: unknown) => error);
  view.hide();
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 0, outcome: 'skipped' }]);
  expect(pings(0)).toBe(1);
  await vi.advanceTimersByTimeAsync(3000);
  await expect(own).resolves.toMatchObject({ code: 'ERR_MQTT_TIMEOUT' });
  stop();
  await client.disconnect();
});

test('an absence shorter than checkAfterMs runs no check', async () => {
  const { peer, client, returns, view, stop, pings } = watched(
    { initialDelayMs: 60_000, maxDelayMs: 60_000 },
    { checkAfterMs: 10_000 },
  );
  await client.session();
  view.hide();
  await vi.advanceTimersByTimeAsync(9999);
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(0);
  view.hide();
  await vi.advanceTimersByTimeAsync(1000);
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([
    { trigger: 'visibilitychange', awayMs: 9999, outcome: 'skipped' },
    { trigger: 'visibilitychange', awayMs: 1000, outcome: 'skipped' },
  ]);
  expect(pings(0)).toBe(0);
  expect(peer.connections).toHaveLength(1);
  view.hide();
  await vi.advanceTimersByTimeAsync(10_000);
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns.at(-1)).toEqual({ trigger: 'visibilitychange', awayMs: 10_000, outcome: 'retried' });
  expect(peer.connections).toHaveLength(2);
  stop();
  await client.disconnect();
});

test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects checkAfterMs %s at once', (checkAfterMs) => {
  const peer = broker();
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteClientOptions in src/transportCore.ts holds a native AbortSignal and Uint8Array callbacks, which createTransportClient keeps by identity.
  const client = createReconnectingClient<ByteClientOptions>((options) => createTransportClient(peer.transport, options), {
    clientId: 'invalid',
  });
  expect(() => watchPageLifecycle(client, { checkAfterMs })).toThrow(RangeError);
  void client.disconnect();
});

test('the stop function removes every listener and ends the reports', async () => {
  const { client, returns, view, stop, pings } = watched();
  await client.session();
  expect(view.listening().sort()).toEqual(['freeze', 'pagehide', 'pageshow', 'resume', 'visibilitychange']);
  view.hide();
  view.show();
  stop();
  stop();
  expect(view.listening()).toEqual([]);
  view.hide();
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([]);
  expect(pings(0)).toBe(1);
  await client.disconnect();
});

test('a page that starts hidden counts its first return', async () => {
  const peer = broker();
  const client = createReconnectingClient<ByteClientOptions>(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteClientOptions in src/transportCore.ts holds a native AbortSignal and Uint8Array callbacks, which createTransportClient keeps by identity.
    (options) => createTransportClient(peer.transport, options),
    { clientId: 'lifecycle' },
  );
  const view = page();
  view.hide();
  const returns: PageReturn[] = [];
  const stop = watchPageLifecycle(client, {
    onReturn(event) {
      returns.push(event);
    },
  });
  await vi.advanceTimersByTimeAsync(2000);
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 2000, outcome: 'answered' }]);
  stop();
  await client.disconnect();
});

test('without window and document the adapter listens for nothing', async () => {
  const peer = broker();
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteClientOptions in src/transportCore.ts holds a native AbortSignal and Uint8Array callbacks, which createTransportClient keeps by identity.
  const client = createReconnectingClient<ByteClientOptions>((options) => createTransportClient(peer.transport, options), {
    clientId: 'server',
  });
  expect(typeof globalThis.document).toBe('undefined');
  const stop = watchPageLifecycle(client);
  expect(stop).not.toThrow();
  expect(vi.getTimerCount()).toBe(0);
  await client.disconnect();
});
