import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ByteTransport } from '../src/byteTransport.js';
import { encodePacket, PacketDecoder, type BrokerPacket } from '../src/codec.js';
import { watchPageLifecycle, type PageReturn } from '../src/pageLifecycle.js';
import { createTransportClient, type ByteClientOptions } from '../src/portableClient.js';
import { createReconnectingClient, type ReconnectEvent } from '../src/reconnect.js';

interface Connection {
  readonly commands: string[];
  silent: boolean;
  end(): void;
}

function broker() {
  const connections: Connection[] = [];
  const transport: ByteTransport = {
    name: 'Lifecycle broker',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- ByteTransport.open in src/byteTransport.ts takes the mutable ByteInbound and returns a promise, and promise-function-async requires an async function for that. This opener settles without waiting for anything.
    async open(inbound) {
      const decoder = new PacketDecoder();
      const connection: Connection = {
        commands: [],
        silent: false,
        end() {
          inbound.end();
        },
      };
      connections.push(connection);
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- encodePacket in src/wireCodec.ts takes the codec's BrokerPacket, whose PUBLISH payload is a native Uint8Array.
      const reply = (packet: BrokerPacket): void => {
        queueMicrotask(() => {
          inbound.bytes(encodePacket(packet));
        });
      };
      return {
        bufferedBytes: 0,
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- ByteWriter.write in src/byteTransport.ts takes the encoded Uint8Array by identity and returns a promise. This writer answers without waiting.
        async write(bytes: Uint8Array) {
          for (const packet of decoder.push(bytes)) {
            if (packet.cmd === 'connack' || packet.cmd === 'suback' || packet.cmd === 'unsuback' || packet.cmd === 'pingresp')
              continue;
            connection.commands.push(packet.cmd);
            if (connection.silent) continue;
            if (packet.cmd === 'connect') reply({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
            else if (packet.cmd === 'pingreq') reply({ cmd: 'pingresp' });
            else if (packet.cmd === 'publish' && packet.qos === 1)
              reply({ cmd: 'puback', messageId: packet.messageId, reasonCode: 0 });
          }
        },
        async close() {},
      };
    },
  };
  return { transport, connections };
}

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

function watched(delayMs = 1000) {
  const peer = broker();
  const events: ReconnectEvent[] = [];
  const returns: PageReturn[] = [];
  const client = createReconnectingClient<ByteClientOptions>(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteClientOptions in src/transportCore.ts holds a native AbortSignal and Uint8Array callbacks, which createTransportClient keeps by identity.
    (options) => createTransportClient(peer.transport, options),
    { clientId: 'lifecycle', onQosOneMessage() {} },
    {
      initialDelayMs: delayMs,
      maxDelayMs: delayMs,
      random: () => 0,
      onReconnect(event) {
        events.push(event);
      },
    },
  );
  const view = page();
  const stop = watchPageLifecycle(client, {
    onReturn(event) {
      returns.push(event);
    },
  });
  return { peer, client, events, returns, view, stop };
}

const pings = (commands: readonly string[] | undefined) => commands?.filter((command) => command === 'pingreq');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a hidden page that becomes visible pings the session once', async () => {
  const { peer, client, returns, view, stop } = watched();
  await client.session();
  view.hide();
  await vi.advanceTimersByTimeAsync(5000);
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 5000, outcome: 'answered' }]);
  expect(pings(peer.connections[0]?.commands)).toHaveLength(1);
  stop();
  await client.disconnect();
});

test('a connection that went silent while hidden ends within timeoutMs, and the next attempt does not wait', async () => {
  const { peer, client, events, returns, view, stop } = watched();
  const stale = await client.session();
  view.hide();
  await vi.advanceTimersByTimeAsync(60_000);
  const silent = peer.connections[0];
  if (silent !== undefined) silent.silent = true;
  view.show();
  await vi.advanceTimersByTimeAsync(2999);
  expect(returns).toEqual([]);
  await expect(client.session()).resolves.toBe(stale);
  await vi.advanceTimersByTimeAsync(1);
  expect(peer.connections).toHaveLength(2);
  const fresh = await client.session();
  expect(fresh).not.toBe(stale);
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

test('a long scheduling pause while waiting starts one attempt on resume and none when the late timer is due', async () => {
  const { peer, client, events, returns, view, stop } = watched(60_000);
  await client.session();
  view.hide();
  view.freeze();
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(events.at(-1)).toMatchObject({ kind: 'retrying', attempt: 2, delayMs: 30_000 });
  view.resume();
  expect(peer.connections).toHaveLength(2);
  await client.session();
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([
    { trigger: 'resume', awayMs: 10_000, outcome: 'retried' },
    { trigger: 'visibilitychange', awayMs: 0, outcome: 'answered' },
  ]);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(peer.connections).toHaveLength(2);
  expect(events.map((event) => event.kind)).toEqual(['connected', 'retrying', 'connected']);
  stop();
  await client.disconnect();
});

test('a publication pending through a ten-minute pause rejects at its deadline and one attempt replaces the session', async () => {
  const { peer, client, events, returns, view, stop } = watched();
  const stale = await client.session();
  const silent = peer.connections[0];
  if (silent !== undefined) silent.silent = true;
  const start = performance.now();
  const publication = stale.publish('sensor/1', 'pending', { qos: 1 }).then(
    () => ({ error: undefined, afterMs: performance.now() - start }),
    (error: unknown) => ({ error, afterMs: performance.now() - start }),
  );
  view.hide();
  view.freeze();
  // A frozen page runs no timer. Its overdue timers run once it resumes, in the order they were due, as this jump runs them.
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  await expect(publication).resolves.toMatchObject({ error: { code: 'ERR_MQTT_TIMEOUT' }, afterMs: 3000 });
  view.resume();
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(peer.connections).toHaveLength(2);
  expect(events.map((event) => event.kind)).toEqual(['connected', 'retrying', 'connected']);
  expect(events.at(-1)).toMatchObject({ previous: { uncertain: [{ topic: 'sensor/1', acknowledged: false }] } });
  await expect(client.session()).resolves.not.toBe(stale);
  expect(returns).toEqual([
    { trigger: 'visibilitychange', awayMs: 0, outcome: 'skipped' },
    { trigger: 'resume', awayMs: 600_000, outcome: 'answered' },
  ]);
  expect(pings(peer.connections[1]?.commands)).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
  stop();
  await client.disconnect();
});

test('pageshow after the back-forward cache retries a connection the browser closed', async () => {
  const { peer, client, events, returns, view, stop } = watched(60_000);
  await client.session();
  view.pageshow(false);
  view.pagehide(true);
  peer.connections[0]?.end();
  await vi.advanceTimersByTimeAsync(5000);
  expect(events.at(-1)).toMatchObject({ kind: 'retrying', delayMs: 30_000 });
  view.pageshow(true);
  expect(peer.connections).toHaveLength(2);
  await client.session();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'pageshow', awayMs: 5000, outcome: 'retried' }]);
  stop();
  await client.disconnect();
});

test('repeated return events send one ping', async () => {
  const { peer, client, returns, view, stop } = watched();
  await client.session();
  view.hide();
  view.pagehide(true);
  view.freeze();
  view.hide();
  await vi.advanceTimersByTimeAsync(1000);
  view.show();
  view.resume();
  view.pageshow(true);
  view.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(returns).toEqual([{ trigger: 'visibilitychange', awayMs: 1000, outcome: 'answered' }]);
  expect(pings(peer.connections[0]?.commands)).toHaveLength(1);
  stop();
  await client.disconnect();
});

test('a return after the client stopped reports stopped and opens nothing', async () => {
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

test('the stop function removes every listener and ends the reports', async () => {
  const { peer, client, returns, view, stop } = watched();
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
  expect(pings(peer.connections[0]?.commands)).toHaveLength(1);
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
