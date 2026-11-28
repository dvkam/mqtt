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

async function until(prefix: string, timeoutMs = 5000): Promise<number> {
  return tab().evaluate(
    async ({ prefix, timeoutMs }: Readonly<{ prefix: string; timeoutMs: number }>) =>
      (await import('/lifecycle.js')).until(prefix, timeoutMs),
    { prefix, timeoutMs },
  );
}

async function setVisibility(state: 'hidden' | 'visible'): Promise<void> {
  await tab().evaluate(async (state: 'hidden' | 'visible') => {
    (await import('/lifecycle.js')).setVisibility(state);
  }, state);
}

async function ready(): Promise<void> {
  await tab().evaluate(async () => (await import('/lifecycle.js')).ready());
}

async function generation(): Promise<number> {
  return tab().evaluate(async () => (await import('/lifecycle.js')).generation());
}

const returns = (log: readonly string[]) => log.filter((entry) => entry.startsWith('return '));

async function leaveAndGoBack(awayMs: number): Promise<boolean> {
  const page = tab();
  await page.goto(fixture.origin + '/b');
  await sleep(awayMs);
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState === 'complete');
  return (await entries()).includes('pageshow persisted=true');
}

// A page without a client shows whether this browser restores a page from the back-forward cache under automation.
async function control(engine: string): Promise<boolean> {
  consoleLog.length = 0;
  await tab().goto(fixture.origin + '/control');
  await listen();
  const restored = await leaveAndGoBack(500);
  console.log(JSON.stringify({ engine, step: 'page without a client', restoredFromCache: restored, events: consoleLog }));
  return restored;
}

// Chromium restores the page from the back-forward cache, keeps its connection open in the cache and fails its WebSocket
// on restore.
async function navigateConnected(engine: string, notCached: readonly unknown[]): Promise<void> {
  consoleLog.length = 0;
  const before = fixture.opened();
  const left = performance.now();
  const restored = await leaveAndGoBack(2000);
  const closedAfterMs = fixture.closedAt() > left ? Math.round(fixture.closedAt() - left) : undefined;
  if (engine !== 'chromium') {
    if (restored) await until('return ', 10_000);
    else await start();
    // A return can be logged before its reconnect connects, so the next step reads the generation of a connected session.
    await ready();
    console.log(
      JSON.stringify({
        engine,
        step: 'page with a connected client',
        restoredFromCache: restored,
        connectionClosedAfterMs: closedAfterMs,
        connectionsOpened: fixture.opened() - before,
        events: consoleLog,
      }),
    );
    return;
  }
  const restoredMs = await until('connected 2');
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
  assert.ok(restoredMs < 5000);
  assert.equal(fixture.opened() - before, 1);
  console.log(`Chromium ${browser().version()} restored the page from the back-forward cache and reconnected at once`);
  console.log(JSON.stringify(await timeline()));
}

// A client that waits for its retry timer holds no WebSocket, so a browser that refuses to cache a page with an open
// WebSocket can cache this one. The restore then reaches the adapter through the events the browser fires.
async function navigateWaiting(engine: string): Promise<void> {
  consoleLog.length = 0;
  const known = returns(await entries()).length;
  fixture.setMode('refuse');
  fixture.drop();
  await until('retrying', 5000);
  const refused = fixture.opened();
  fixture.setMode('forward');
  const restored = await leaveAndGoBack(1000);
  if (restored) {
    const reconnectMs = await until('return ', 10_000);
    await ready();
    assert.equal(fixture.opened() - refused, 1);
    console.log(
      JSON.stringify({
        engine,
        step: 'page with a waiting client',
        restoredFromCache: true,
        returns: returns(await entries()).slice(known),
        reconnectMs: Math.round(reconnectMs),
        timeline: await timeline(),
      }),
    );
    return;
  }
  await start();
  console.log(JSON.stringify({ engine, step: 'page with a waiting client', restoredFromCache: false, events: consoleLog }));
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
  let known = returns(await entries()).length;
  let connections = fixture.opened();
  fixture.stall();
  await setVisibility('hidden');
  await setVisibility('visible');
  const stalledMs = await until(`connected ${String(session + 1)} ERR_MQTT_TIMEOUT`);
  assert.ok(stalledMs >= 900 && stalledMs < 3000, `Reconnected after ${String(stalledMs)} ms`);
  await until('return ');
  assert.deepEqual(returns(await entries()).slice(known), ['return visibilitychange retried']);
  assert.equal(fixture.opened() - connections, 1);
  console.log(
    `${engine}: a silent connection ended at its ping deadline, and the next session connected ${String(Math.round(stalledMs))} ms after the return`,
  );

  session = await generation();
  known = returns(await entries()).length;
  connections = fixture.opened();
  fixture.stall();
  await setVisibility('hidden');
  const pending = await page.evaluate(
    async (topic) => (await import('/lifecycle.js')).publishPending(topic),
    `ci/lifecycle/${String(process.pid)}`,
  );
  assert.equal(pending.code, 'ERR_MQTT_TIMEOUT');
  assert.ok(pending.elapsedMs >= 900 && pending.elapsedMs < 2000, `Settled after ${String(pending.elapsedMs)} ms`);
  await until('retrying');
  await setVisibility('visible');
  await until(`connected ${String(session + 1)} ERR_MQTT_TIMEOUT uncertain=1`, 3000);
  assert.deepEqual(returns(await entries()).slice(known), ['return visibilitychange retried']);
  assert.equal(fixture.opened() - connections, 1);
  console.log(
    `${engine}: a pending QoS 1 publication rejected after ${String(Math.round(pending.elapsedMs))} ms, and the return reconnected at once`,
  );

  known = returns(await entries()).length;
  connections = fixture.opened();
  await page.evaluate(async () => {
    (await import('/lifecycle.js')).dispatchRestore();
  });
  await until('return pageshow');
  await sleep(500);
  assert.deepEqual(returns(await entries()).slice(known), ['return pageshow answered']);
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
    if (engine === 'firefox') {
      // PROBE: does Firefox restore from the cache once the session history may keep viewers?
      const probes: Record<string, number | boolean>[] = [
        { 'browser.sessionhistory.max_total_viewers': 8 },
        { 'browser.sessionhistory.max_total_viewers': 8, 'fission.bfcacheInParent': true },
      ];
      for (const prefs of probes) {
        current = await firefox.launch({ firefoxUserPrefs: prefs });
        try {
          active = await current.newPage();
          tab().on('console', (message: Readonly<{ text: () => string }>) => {
            const text = message.text();
            if (text.startsWith('lifecycle ')) consoleLog.push(text.slice('lifecycle '.length));
          });
          console.log('PROBE', JSON.stringify(prefs));
          const restored = await Promise.race([control(engine), sleep(20_000).then(() => 'timed out')]);
          console.log('PROBE restored', restored);
          if (restored === true) {
            await tab().goto(fixture.origin + '/a');
            await start();
            const back = await Promise.race([leaveAndGoBack(2000), sleep(20_000).then(() => 'timed out')]);
            console.log('PROBE connected page restored', back, JSON.stringify(consoleLog), JSON.stringify(await timeline()));
          }
        } catch (error) {
          console.log('PROBE failed', String(error));
        } finally {
          active = undefined;
          await current.close();
          current = undefined;
        }
      }
    }
  }
} finally {
  fixture.close();
}
