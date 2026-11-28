import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import { createFixture, sleep, waitFor, type Report } from './page-lifecycle-fixture.ts';
import type { Retry } from './page-lifecycle-page.ts';

// Playwright keeps every page visible and focused, passes --disable-background-timer-throttling and keeps a DevTools
// session on every page, which blocks a discard. This check starts Chromium itself with none of Playwright's switches.
// For the hidden, throttled and frozen tab, Playwright attaches with noDefaults. For the discard, a second Chromium
// loads an extension, and a DevTools connection with no session on the tab calls chrome.tabs.discard in it.

const inputRoot = process.argv[2];
assert.ok(inputRoot !== undefined && inputRoot !== '', 'Expected packed consumer directory');
const brokerUrl = new URL(process.argv[3] ?? '');
assert.equal(brokerUrl.protocol, 'ws:', 'Expected a ws:// broker URL');
const fixture = await createFixture(resolve(inputRoot), brokerUrl);

interface Chromium {
  /** The host and port of the DevTools endpoint. */
  readonly endpoint: string;
  /** The path of the browser target on that endpoint. */
  readonly browserPath: string;
  readonly stop: () => void;
}

const running = new Set<Chromium>();

async function launch(switches: readonly string[]): Promise<Chromium> {
  const profile = mkdtempSync(join(tmpdir(), 'mqtt-lifecycle-'));
  const child = spawn(
    chromium.executablePath(),
    [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--password-store=basic',
      ...(process.env['MQTT_TEST_HEADED'] === '1' ? [] : ['--headless=new']),
      ...switches,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  await waitFor(() => existsSync(portFile) && readFileSync(portFile, 'utf8').split('\n').length >= 2, 'Chromium to start', 20_000);
  const [port = '', browserPath = ''] = readFileSync(portFile, 'utf8').split('\n');
  const browser: Chromium = {
    endpoint: `127.0.0.1:${port}`,
    browserPath,
    stop() {
      running.delete(browser);
      child.kill();
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  running.add(browser);
  return browser;
}

// A step that hangs names itself, because a DevTools command to a hidden or discarded tab can stay unanswered.
let watchdog: ReturnType<typeof setTimeout> | undefined;
function enter(step: string, budgetMs = 60_000): void {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    console.error(`The check hung in the step "${step}"`);
    for (const browser of running) browser.stop();
    process.exit(1);
  }, budgetMs);
}

let current: Browser | undefined;
let client: Page | undefined;
let cover: Page | undefined;
let devtools: CDPSession | undefined;
const tab = (): Page => {
  if (client === undefined) throw new Error('No page');
  return client;
};

async function start(retry?: Readonly<Retry>): Promise<void> {
  await tab().evaluate(
    async ({ url, clientId, retry }: Readonly<{ url: string; clientId: string; retry: Readonly<Retry> | undefined }>) =>
      (await import('/lifecycle.js')).start(url, clientId, retry),
    { url: fixture.proxyUrl, clientId: fixture.clientId, retry },
  );
}

async function entries(): Promise<string[]> {
  return tab().evaluate(async () => (await import('/lifecycle.js')).entries());
}

async function timeline(): Promise<string[]> {
  return tab().evaluate(async () => (await import('/lifecycle.js')).timeline());
}

async function generation(): Promise<number> {
  return tab().evaluate(async () => (await import('/lifecycle.js')).generation());
}

async function timerChain(): Promise<number> {
  return tab().evaluate(async () => (await import('/lifecycle.js')).timerChain(3, 10));
}

// The test polls from Node, because a timer loop in a hidden page is throttled itself.
async function until(prefix: string, from: number, timeoutMs = 5000): Promise<number> {
  const started = performance.now();
  for (;;) {
    const log = await entries();
    if (log.slice(from).some((entry) => entry.startsWith(prefix))) return performance.now() - started;
    if (performance.now() - started > timeoutMs) throw new Error(`No "${prefix}" in ${JSON.stringify(log.slice(from))}`);
    await sleep(10);
  }
}

async function visibility(): Promise<string> {
  return tab().evaluate(() => document.visibilityState);
}

async function hide(): Promise<void> {
  await cover?.bringToFront();
  const started = performance.now();
  while ((await visibility()) !== 'hidden') {
    if (performance.now() - started > 5000) throw new Error('The tab stayed visible');
    await sleep(10);
  }
}

async function show(): Promise<void> {
  await tab().bringToFront();
}

async function open(path: string, retry?: Readonly<Retry>): Promise<void> {
  await show();
  await tab().goto(fixture.origin + path);
  const before = fixture.opened();
  await start(retry);
  assert.equal(fixture.opened() - before, 1);
}

const returns = (log: readonly string[]) => log.filter((entry) => entry.startsWith('return '));

// A hidden tab aligns its timers to one wake-up a second. A pending publication still rejects at its deadline plus that
// second, and the return starts the next attempt without the retry timer.
async function throttled(): Promise<void> {
  await open('/throttled');
  const visibleChainMs = await timerChain();
  await hide();
  const hiddenChainMs = await timerChain();
  assert.ok(visibleChainMs < 500, `Three 10 ms timers took ${String(visibleChainMs)} ms in the visible tab`);
  assert.ok(hiddenChainMs >= 1900, `Three 10 ms timers took ${String(hiddenChainMs)} ms in the hidden tab`);

  const session = await generation();
  const known = (await entries()).length;
  const connections = fixture.opened();
  fixture.stall();
  const pending = await tab().evaluate(
    async (topic) => (await import('/lifecycle.js')).publishPending(topic),
    `ci/lifecycle/${String(process.pid)}`,
  );
  assert.equal(pending.code, 'ERR_MQTT_TIMEOUT');
  assert.ok(pending.elapsedMs >= 900 && pending.elapsedMs < 2200, `Settled after ${String(pending.elapsedMs)} ms`);
  await until('retrying ', known);
  await sleep(1500);
  assert.equal(fixture.opened(), connections, 'The retry timer of 10 to 20 seconds started no attempt');
  await show();
  const reconnectMs = await until(`connected ${String(session + 1)} ERR_MQTT_TIMEOUT uncertain=1`, known);
  await until('return ', known);
  const log = (await entries()).slice(known);
  assert.deepEqual(returns(log), ['return visibilitychange retried']);
  assert.ok(reconnectMs < 1500, `Reconnected ${String(reconnectMs)} ms after the return`);
  assert.equal(fixture.opened() - connections, 1);
  console.log(
    JSON.stringify({
      step: 'hidden tab with throttled timers',
      visibleChainMs: Math.round(visibleChainMs),
      hiddenChainMs: Math.round(hiddenChainMs),
      publishRejectedAfterMs: Math.round(pending.elapsedMs),
      reconnectMs: Math.round(reconnectMs),
      log,
    }),
  );

  const next = await generation();
  const knownSilent = (await entries()).length;
  const before = fixture.opened();
  await hide();
  fixture.stall();
  await sleep(1500);
  assert.equal(fixture.opened(), before, 'A silent connection is not noticed while the tab is hidden');
  await show();
  const silentMs = await until(`connected ${String(next + 1)} ERR_MQTT_TIMEOUT`, knownSilent);
  await until('return ', knownSilent);
  assert.deepEqual(returns((await entries()).slice(knownSilent)), ['return visibilitychange retried']);
  assert.ok(silentMs >= 900 && silentMs < 3000, `Reconnected after ${String(silentMs)} ms`);
  assert.equal(fixture.opened() - before, 1);
  console.log(JSON.stringify({ step: 'silent connection in a hidden tab', reconnectMs: Math.round(silentMs) }));
}

// The retry loop of a client whose attempts time out is a chain of timers. After the grace period, Chromium wakes such
// a chain once a minute, so the attempt deadline of 1,000 milliseconds and the retry timer of 200 milliseconds run
// late. The check returns to the tab once the timer in `late` is 3 seconds overdue.
async function wakeUps(late: 'attempt deadline' | 'retry timer'): Promise<void> {
  const session = await generation();
  const known = (await entries()).length;
  await hide();
  const hiddenAt = performance.now();
  fixture.setMode('silent');
  fixture.drop();
  const closed = fixture.durations().length;
  // With one wake-up a second, an attempt closes at most 2 seconds after it opened, and the next one opens at most
  // 1,200 milliseconds later.
  const overdue = (): number => {
    if (late === 'retry timer') return fixture.open() === 0 ? performance.now() - fixture.closedAt() - 200 : 0;
    return fixture.open() === 1 ? performance.now() - fixture.openedAt() - 1000 : 0;
  };
  await waitFor(() => fixture.durations().length > closed + 1 && overdue() > 3000, 'a late ' + late, 150_000);
  const overdueMs = overdue();
  const attempts = fixture.durations().slice(closed + 1);
  const hiddenMs = performance.now() - hiddenAt;
  const connections = fixture.opened();
  fixture.setMode('forward');
  await show();
  const reconnectMs = await until(`connected ${String(session + 1)} `, known);
  await until('return ', known);
  const outcomes = returns((await entries()).slice(known));
  if (late === 'retry timer') assert.deepEqual(outcomes, ['return visibilitychange retried']);
  else {
    // The adapter leaves an open attempt alone. The overdue deadline ends it once the tab is visible, and the client
    // waits its 200 milliseconds before the next attempt. The deadline can also run before the event of the return.
    assert.equal(outcomes.length, 1);
    assert.match(outcomes[0] ?? '', /^return visibilitychange (?:connecting|retried)$/u);
  }
  assert.ok(reconnectMs < 1500, `Reconnected ${String(reconnectMs)} ms after the return`);
  assert.equal(fixture.opened() - connections, 1);
  console.log(
    JSON.stringify({
      step: `hidden tab with one wake-up a minute and a late ${late}`,
      hiddenMs: Math.round(hiddenMs),
      attemptsWhileHidden: attempts.length,
      longestAttemptMs: Math.round(Math.max(...attempts)),
      overdueMs: Math.round(overdueMs),
      outcomes,
      reconnectMs: Math.round(reconnectMs),
    }),
  );
}

async function intensive(): Promise<void> {
  await open('/intensive', { delayMs: 200, maxAttempts: 1000 });
  await wakeUps('attempt deadline');
  await wakeUps('retry timer');
}

// Chromium can freeze a hidden tab. A frozen page runs no timer. The DevTools command freezes this tab the same way.
async function freeze(ms: number): Promise<void> {
  await devtools?.send('Page.setWebLifecycleState', { state: 'frozen' });
  await sleep(ms);
  assert.equal(fixture.open(), 1, 'The connection of the frozen tab stays open');
  await devtools?.send('Page.setWebLifecycleState', { state: 'active' });
}

async function frozen(): Promise<void> {
  await open('/frozen');
  await hide();
  let session = await generation();
  let known = (await entries()).length;
  let connections = fixture.opened();
  await freeze(3000);
  await sleep(1500);
  // Chromium fails the WebSocket of a frozen page when the page resumes, as it does after the back-forward cache.
  const healthy = (await entries()).slice(known);
  assert.deepEqual(healthy.slice(0, 2), ['freeze hidden', 'resume hidden']);
  assert.match(healthy[2] ?? '', /^retrying \d+ MQTT WebSocket failed$/u);
  assert.equal(healthy.length, 3, JSON.stringify(healthy));
  assert.equal(fixture.opened(), connections);
  await show();
  const healthyMs = await until(`connected ${String(session + 1)} ERR_MQTT_TRANSPORT uncertain=0`, known);
  await until('return ', known);
  assert.deepEqual(returns((await entries()).slice(known)), ['return visibilitychange retried']);
  assert.equal(fixture.opened() - connections, 1);
  console.log(
    JSON.stringify({
      step: 'frozen hidden tab with a healthy connection',
      reconnectMs: Math.round(healthyMs),
      log: (await entries()).slice(known),
    }),
  );
  await hide();

  session = await generation();
  known = (await entries()).length;
  connections = fixture.opened();
  fixture.stall();
  await tab().evaluate(async (topic) => (await import('/lifecycle.js')).startPublish(topic), `ci/lifecycle/${String(process.pid)}`);
  await freeze(3000);
  await until('retrying ', known);
  const pending = await tab().evaluate(async () => (await import('/lifecycle.js')).published());
  assert.ok(pending !== undefined);
  // The failed WebSocket and the overdue deadline both reject the publication. Chromium reported the WebSocket first.
  assert.ok(pending.code === 'ERR_MQTT_TRANSPORT' || pending.code === 'ERR_MQTT_TIMEOUT', pending.code);
  assert.ok(pending.elapsedMs >= 3000 && pending.elapsedMs < 5000, `Settled after ${String(pending.elapsedMs)} ms`);
  const resumed = (await entries()).slice(known);
  assert.deepEqual(resumed.slice(0, 2), ['freeze hidden', 'resume hidden']);
  assert.deepEqual(returns(resumed), [], 'A resume that leaves the tab hidden is no return');
  assert.equal(fixture.opened(), connections);
  await show();
  const reconnectMs = await until(`connected ${String(session + 1)} `, known);
  await until('return ', known);
  const log = (await entries()).slice(known);
  assert.deepEqual(returns(log), ['return visibilitychange retried']);
  assert.ok(reconnectMs < 1500, `Reconnected ${String(reconnectMs)} ms after the return`);
  assert.equal(fixture.opened() - connections, 1);
  console.log(
    JSON.stringify({
      step: 'frozen hidden tab with a pending publication',
      publishRejected: pending.code,
      publishRejectedAfterMs: Math.round(pending.elapsedMs),
      reconnectMs: Math.round(reconnectMs),
      log,
    }),
  );
}

interface Devtools {
  readonly send: (method: string, params?: Readonly<Record<string, unknown>>, sessionId?: string) => Promise<unknown>;
  readonly close: () => void;
}

// A DevTools connection to the browser target. It attaches to no page unless the test asks for it.
async function connectDevtools(browser: Readonly<Chromium>): Promise<Devtools> {
  const socket = new WebSocket(`ws://${browser.endpoint}${browser.browserPath}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let last = 0;
  const waiting = new Map<number, PromiseWithResolvers<unknown>>();
  socket.addEventListener('message', (event: Readonly<{ data: unknown }>) => {
    const message: unknown = JSON.parse(String(event.data));
    if (typeof message !== 'object' || message === null || !('id' in message) || typeof message.id !== 'number') return;
    const reply = waiting.get(message.id);
    waiting.delete(message.id);
    if ('error' in message) reply?.reject(new Error(JSON.stringify(message.error)));
    else reply?.resolve('result' in message ? message.result : undefined);
  });
  return {
    async send(method, params = {}, sessionId) {
      const reply = Promise.withResolvers<unknown>();
      const id = ++last;
      waiting.set(id, reply);
      socket.send(JSON.stringify({ id, method, params, sessionId }));
      const timer = setTimeout(() => {
        reply.reject(new Error(`${method} got no reply`));
      }, 15_000);
      try {
        return await reply.promise;
      } finally {
        clearTimeout(timer);
      }
    },
    close() {
      socket.close();
    },
  };
}

function text(value: unknown, name: string): string {
  assert.ok(typeof value === 'object' && value !== null && name in value, `Expected ${name} in ${JSON.stringify(value)}`);
  const found: unknown = Object.getOwnPropertyDescriptor(value, name)?.value;
  assert.ok(typeof found === 'string', `Expected a string ${name} in ${JSON.stringify(value)}`);
  return found;
}

// The report of a load without its page events, which leaves what the client and the adapter recorded.
function clientReport(index: number): Report | undefined {
  const report = fixture.reports()[index];
  if (report === undefined) return undefined;
  return { wasDiscarded: report.wasDiscarded, entries: report.entries.filter((entry) => !entry.startsWith('pageshow ')) };
}

// A discarded tab loses its document and its connection, and it loads again when the user returns to it. The new
// document starts with no state of the old one, so it must connect once. Chromium discards no tab that has a DevTools
// session, so the test watches the tab through the proxy and through what the page posts to the HTTP server. The
// service worker of an extension discards the tab with chrome.tabs.discard, as a tab manager extension does.
// chrome://discards can discard a tab too, but opening it crashed Chrome for Testing 159.0.8154.6.
async function discarded(): Promise<void> {
  enter('start Chromium with the extension');
  const extension = mkdtempSync(join(tmpdir(), 'mqtt-discard-'));
  writeFileSync(
    join(extension, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Discard a tab',
      version: '1',
      permissions: ['tabs'],
      background: { service_worker: 'discard.js' },
    }),
  );
  writeFileSync(join(extension, 'discard.js'), '');
  const browser = await launch([`--load-extension=${extension}`]);
  const cdp = await connectDevtools(browser);
  try {
    enter('attach to the extension');
    let worker: string | undefined;
    for (let tries = 0; tries < 500 && worker === undefined; tries++) {
      await sleep(20);
      const targets = await cdp.send('Target.getTargets');
      assert.ok(typeof targets === 'object' && targets !== null && 'targetInfos' in targets && Array.isArray(targets.targetInfos));
      const infos: readonly unknown[] = targets.targetInfos;
      const found = infos.find((info) => text(info, 'type') === 'service_worker' && text(info, 'url').endsWith('/discard.js'));
      if (found !== undefined) worker = text(found, 'targetId');
    }
    assert.ok(worker !== undefined, 'The extension started no service worker');
    const sessionId = text(await cdp.send('Target.attachToTarget', { targetId: worker, flatten: true }), 'sessionId');

    enter('open the tab to discard');
    const before = fixture.opened();
    const auto = text(await cdp.send('Target.createTarget', { url: fixture.origin + '/auto' }), 'targetId');
    await waitFor(() => fixture.reports().length === 1, 'the first report of the tab');
    assert.deepEqual(clientReport(0), { wasDiscarded: false, entries: ['connected 1  uncertain=0'] });
    assert.equal(fixture.opened() - before, 1);
    await cdp.send('Target.createTarget', { url: fixture.origin + '/cover' });
    await waitFor(() => fixture.beacons().includes('visibilitychange hidden'), 'the tab to be hidden');

    enter('discard the tab');
    const discardedAt = performance.now();
    const reply = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `chrome.tabs.query({ url: ${JSON.stringify(fixture.origin + '/auto')} })
          .then(([tab]) => chrome.tabs.discard(tab.id))
          .then((tab) => String(tab?.discarded) + ' ' + String(tab?.status))`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    assert.ok(typeof reply === 'object' && reply !== null && 'result' in reply, JSON.stringify(reply));
    assert.equal(text(reply.result, 'value'), 'true unloaded');
    await waitFor(() => fixture.open() === 0, 'the connection of the discarded tab to close');
    const closedAfterMs = fixture.closedAt() - discardedAt;
    await sleep(1500);
    const beacons = [...fixture.beacons()];
    assert.equal(fixture.opened() - before, 1, 'A discarded tab opens no connection');
    assert.equal(fixture.reports().length, 1);

    enter('return to the discarded tab');
    const returnedAt = performance.now();
    await cdp.send('Target.activateTarget', { targetId: auto });
    await waitFor(() => fixture.reports().length === 2, 'the report of the reloaded tab', 10_000);
    const reconnectMs = performance.now() - returnedAt;
    assert.deepEqual(clientReport(1), { wasDiscarded: true, entries: ['connected 1  uncertain=0'] });
    await sleep(1500);
    assert.equal(fixture.opened() - before, 2, 'The reloaded tab connects once');
    assert.equal(fixture.open(), 1);
    assert.equal(fixture.reports().length, 2);
    console.log(
      JSON.stringify({
        step: 'discarded tab',
        eventsBeforeDiscard: beacons,
        connectionClosedAfterMs: Math.round(closedAfterMs),
        connectedAfterReturnMs: Math.round(reconnectMs),
        reports: fixture.reports(),
      }),
    );
  } finally {
    cdp.close();
    browser.stop();
    rmSync(extension, { recursive: true, force: true });
  }
}

async function hidden(): Promise<string> {
  enter('start Chromium');
  // Chromium throttles chained timers to one wake-up a minute once a page was hidden for 5 minutes. This parameter of
  // the feature shortens the 5 minutes to 10 seconds.
  const browser = await launch(['--enable-features=IntensiveWakeUpThrottling:grace_period_seconds/10']);
  try {
    current = await chromium.connectOverCDP(`http://${browser.endpoint}`, { noDefaults: true });
    const [context] = current.contexts();
    assert.ok(context !== undefined);
    client = context.pages()[0] ?? (await context.newPage());
    devtools = await context.newCDPSession(client);
    cover = await context.newPage();
    await cover.goto(fixture.origin + '/cover');
    try {
      enter('throttled timers');
      await throttled();
      enter('one wake-up a minute', 330_000);
      await intensive();
      enter('frozen tab');
      await frozen();
    } catch (error) {
      console.log('The hidden tab check failed with this page log');
      console.log(JSON.stringify(await timeline().catch(() => 'The page was gone')));
      throw error;
    }
    enter('stop the client');
    await tab().evaluate(async () => {
      await (await import('/lifecycle.js')).stop();
    });
    await waitFor(() => fixture.open() === 0, 'the connection of the stopped client to close');
    return current.version();
  } finally {
    browser.stop();
  }
}

try {
  const version = await hidden();
  await discarded();
  console.log(`Packed chromium ${version} hidden, frozen and discarded tab check passed`);
} finally {
  clearTimeout(watchdog);
  for (const browser of running) browser.stop();
  fixture.close();
}
