import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium, firefox, webkit, type Browser, type Page } from 'playwright';
import { createFixture, sleep, waitFor } from './page-lifecycle-fixture.ts';

const inputRoot = process.argv[2];
assert.ok(inputRoot !== undefined && inputRoot !== '', 'Expected packed consumer directory');
const brokerUrl = new URL(process.argv[3] ?? '');
assert.equal(brokerUrl.protocol, 'ws:', 'Expected a ws:// broker URL');
const fixture = await createFixture(resolve(inputRoot), brokerUrl);
const engines = process.argv.slice(4);
if (engines.length === 0) engines.push('chromium');

async function launch(engine: string): Promise<Browser> {
  // Playwright starts Chromium with --disable-back-forward-cache, and the headless shell refuses the cache with
  // BackForwardCacheDisabledForDelegate. The full Chromium build in new headless mode keeps the page in the cache.
  if (engine === 'chromium') return chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  if (engine === 'firefox') return firefox.launch();
  if (engine === 'webkit') return webkit.launch();
  throw new Error('Unknown browser engine ' + engine);
}

let current: Browser | undefined;
const browser = (): Browser => {
  if (current === undefined) throw new Error('No browser');
  return current;
};
let active: Page | undefined;
const tab = (): Page => {
  if (active === undefined) throw new Error('No page');
  return active;
};
// Each entry the page records, as its console delivered it. It also holds the entries of a page that was unloaded.
const consoleLog: string[] = [];

async function listen(): Promise<void> {
  await tab().evaluate(async () => {
    (await import('/lifecycle.js')).listen();
  });
}

async function start(): Promise<void> {
  await tab().evaluate(
    async ({ url, clientId }: Readonly<{ url: string; clientId: string }>) => (await import('/lifecycle.js')).start(url, clientId),
    { url: fixture.proxyUrl, clientId: fixture.clientId },
  );
}

async function entries(): Promise<string[]> {
  return tab().evaluate(async () => (await import('/lifecycle.js')).entries());
}

async function timeline(): Promise<string[]> {
  return tab().evaluate(async () => (await import('/lifecycle.js')).timeline());
}

async function until(prefix: string, from = 0, timeoutMs = 5000): Promise<number> {
  return tab().evaluate(
    async ({ prefix, timeoutMs, from }: Readonly<{ prefix: string; timeoutMs: number; from: number }>) =>
      (await import('/lifecycle.js')).until(prefix, timeoutMs, from),
    { prefix, timeoutMs, from },
  );
}

async function setVisibility(state: 'hidden' | 'visible'): Promise<void> {
  await tab().evaluate(async (state: 'hidden' | 'visible') => {
    (await import('/lifecycle.js')).setVisibility(state);
  }, state);
}

async function generation(): Promise<number> {
  return tab().evaluate(async () => (await import('/lifecycle.js')).generation());
}

const returns = (log: readonly string[]) => log.filter((entry) => entry.startsWith('return '));

// Playwright 1.65.1 turns the back-forward cache off in its Firefox and WebKit builds, so page.goBack() loads the page
// again there. A Firefox with browser.sessionhistory.max_total_viewers of 8 still did not cache a page without a client,
// and with fission.bfcacheInParent the navigation never finished.
const caches = (engine: string): boolean => engine === 'chromium';

async function leaveAndGoBack(awayMs: number): Promise<Readonly<{ restored: boolean; openWhileAway: number }>> {
  const page = tab();
  await page.goto(fixture.origin + '/b');
  await sleep(awayMs);
  const openWhileAway = fixture.open();
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState === 'complete');
  return { restored: (await entries()).includes('pageshow persisted=true'), openWhileAway };
}

// The milliseconds between the last entry that starts with `from` and the last entry that starts with `to`.
function between(log: readonly string[], from: string, to: string): number {
  const at = (prefix: string): number =>
    Number.parseInt(log.findLast((entry) => entry.slice(entry.indexOf(' ') + 1).startsWith(prefix)) ?? '', 10);
  return at(to) - at(from);
}

// A page without a client shows whether this browser restores a page from the back-forward cache under automation.
async function control(engine: string): Promise<void> {
  consoleLog.length = 0;
  await tab().goto(fixture.origin + '/control');
  await listen();
  const { restored } = await leaveAndGoBack(500);
  assert.equal(restored, caches(engine));
  if (restored) {
    assert.deepEqual(consoleLog, [
      'pagehide persisted=true',
      'visibilitychange hidden',
      'freeze hidden',
      'resume hidden',
      'visibilitychange visible',
      'pageshow persisted=true',
    ]);
  } else assert.deepEqual(consoleLog, ['pagehide persisted=false', 'visibilitychange hidden']);
  console.log(JSON.stringify({ engine, step: 'page without a client', restoredFromCache: restored, events: consoleLog }));
}

// Chromium keeps the connection of a cached page open and fails its WebSocket on restore. Firefox and WebKit unload the
// page, which closes the connection, and load it again on the way back.
async function navigateConnected(engine: string, notCached: readonly unknown[]): Promise<void> {
  consoleLog.length = 0;
  const before = fixture.opened();
  const left = performance.now();
  const { restored, openWhileAway } = await leaveAndGoBack(2000);
  assert.equal(restored, caches(engine));
  if (!restored) {
    assert.equal(openWhileAway, 0, 'The connection of the unloaded page closed');
    const closedAfterMs = Math.round(fixture.closedAt() - left);
    assert.ok(consoleLog.includes('pagehide persisted=false'), JSON.stringify(consoleLog));
    assert.equal(fixture.opened(), before, 'The unloaded page opened no connection');
    const events = [...consoleLog];
    await start();
    assert.equal(fixture.opened() - before, 1);
    console.log(
      JSON.stringify({
        engine,
        step: 'page with a connected client',
        restoredFromCache: false,
        connectionClosedAfterMs: closedAfterMs,
        eventsOfTheUnloadedPage: events,
      }),
    );
    return;
  }
  assert.equal(openWhileAway, 1, 'The connection of the cached page stays open');
  await until('connected 2');
  assert.deepEqual(notCached, []);
  const log = await entries();
  for (const expected of ['pagehide persisted=true', 'freeze hidden', 'resume hidden', 'pageshow persisted=true'])
    assert.ok(log.includes(expected), `Expected "${expected}" in ${JSON.stringify(log)}`);
  assert.ok(
    log.some((entry) => /^retrying \d+ MQTT WebSocket failed$/u.test(entry)),
    JSON.stringify(log),
  );
  await until('return ');
  assert.deepEqual(returns(await entries()), ['return visibilitychange retried']);
  await waitFor(() => fixture.open() === 1, 'the connection of the cached page to close');
  assert.equal(fixture.opened() - before, 1);
  const times = await timeline();
  console.log(
    JSON.stringify({
      engine,
      step: 'page with a connected client',
      restoredFromCache: true,
      reconnectMs: between(times, 'return ', 'connected 2'),
      timeline: times,
    }),
  );
}

// A client that waits for its retry timer holds no WebSocket. The restore reaches the adapter through the events the
// browser fires, and the adapter starts the attempt that the timer of 10 to 20 seconds would have started.
async function navigateWaiting(engine: string): Promise<void> {
  consoleLog.length = 0;
  const known = (await entries()).length;
  const session = await generation();
  fixture.setMode('refuse');
  fixture.drop();
  await until('retrying ', known);
  const refused = fixture.opened();
  fixture.setMode('forward');
  const { restored } = await leaveAndGoBack(1000);
  assert.equal(restored, caches(engine));
  if (!restored) {
    assert.equal(fixture.opened(), refused, 'The unloaded page opened no connection');
    const events = [...consoleLog];
    await start();
    console.log(
      JSON.stringify({ engine, step: 'page with a waiting client', restoredFromCache: false, eventsOfTheUnloadedPage: events }),
    );
    return;
  }
  await until(`connected ${String(session + 1)} `, known);
  const log = (await entries()).slice(known);
  assert.deepEqual(returns(log), ['return visibilitychange retried']);
  assert.ok(log.indexOf('resume hidden') < log.indexOf('visibilitychange visible'), JSON.stringify(log));
  assert.equal(fixture.opened() - refused, 1);
  const times = await timeline();
  console.log(
    JSON.stringify({
      engine,
      step: 'page with a waiting client',
      restoredFromCache: true,
      reconnectMs: between(times, 'return ', `connected ${String(session + 1)} `),
      log,
    }),
  );
}

async function check(engine: string): Promise<void> {
  const page = tab();
  page.on('console', (message: Readonly<{ text: () => string }>) => {
    const text = message.text();
    if (text.startsWith('lifecycle ')) consoleLog.push(text.slice('lifecycle '.length));
  });
  const notCached: unknown[] = [];
  if (engine === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.enable');
    cdp.on('Page.backForwardCacheNotUsed', (event: Readonly<{ notRestoredExplanations: readonly unknown[] }>) => {
      notCached.push(event.notRestoredExplanations);
    });
  }
  await control(engine);
  const before = fixture.opened();
  await page.goto(fixture.origin + '/a');
  await start();
  assert.equal(fixture.opened() - before, 1);
  await navigateConnected(engine, notCached);
  await navigateWaiting(engine);

  let session = await generation();
  let known = (await entries()).length;
  let connections = fixture.opened();
  fixture.stall();
  await setVisibility('hidden');
  await setVisibility('visible');
  const stalledMs = await until(`connected ${String(session + 1)} ERR_MQTT_TIMEOUT`, known);
  assert.ok(stalledMs >= 900 && stalledMs < 3000, `Reconnected after ${String(stalledMs)} ms`);
  await until('return ', known);
  assert.deepEqual(returns((await entries()).slice(known)), ['return visibilitychange retried']);
  assert.equal(fixture.opened() - connections, 1);
  console.log(
    `${engine}: a silent connection ended at its ping deadline, and the next session connected ${String(Math.round(stalledMs))} ms after the return`,
  );

  session = await generation();
  known = (await entries()).length;
  connections = fixture.opened();
  fixture.stall();
  await setVisibility('hidden');
  const pending = await page.evaluate(
    async (topic) => (await import('/lifecycle.js')).publishPending(topic),
    `ci/lifecycle/${String(process.pid)}`,
  );
  assert.equal(pending.code, 'ERR_MQTT_TIMEOUT');
  assert.ok(pending.elapsedMs >= 900 && pending.elapsedMs < 2000, `Settled after ${String(pending.elapsedMs)} ms`);
  await until('retrying ', known);
  await setVisibility('visible');
  const pendingMs = await until(`connected ${String(session + 1)} ERR_MQTT_TIMEOUT uncertain=1`, known, 3000);
  await until('return ', known);
  assert.deepEqual(returns((await entries()).slice(known)), ['return visibilitychange retried']);
  assert.equal(fixture.opened() - connections, 1);
  console.log(
    `${engine}: a pending QoS 1 publication rejected after ${String(Math.round(pending.elapsedMs))} ms, and the next session connected ${String(Math.round(pendingMs))} ms after the return`,
  );

  known = (await entries()).length;
  connections = fixture.opened();
  await page.evaluate(async () => {
    (await import('/lifecycle.js')).dispatchRestore();
  });
  await until('return pageshow', known);
  await sleep(500);
  assert.deepEqual(returns((await entries()).slice(known)), ['return pageshow answered']);
  assert.equal(fixture.opened(), connections);
  await page.evaluate(async () => {
    await (await import('/lifecycle.js')).stop();
  });
  console.log(`Packed ${engine} ${browser().version()} page lifecycle check passed`);
}

try {
  for (const engine of engines) {
    current = await launch(engine);
    try {
      active = await current.newPage();
      await check(engine);
    } catch (error) {
      console.log(`${engine} ${current.version()} failed with this page log`);
      console.log(JSON.stringify(await timeline().catch(() => 'The page was gone')));
      console.log(JSON.stringify(consoleLog));
      throw error;
    } finally {
      active = undefined;
      await current.close();
      current = undefined;
    }
    await waitFor(() => fixture.open() === 0, 'the connections of ' + engine + ' to close');
  }
} finally {
  fixture.close();
}
