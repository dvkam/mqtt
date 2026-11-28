import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cpSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { chromium, firefox, webkit, type Browser, type Page } from 'playwright';
import { build } from 'vite';

const inputRoot = process.argv[2];
assert.ok(inputRoot !== undefined && inputRoot !== '', 'Expected packed consumer directory');
const root = resolve(inputRoot);
const brokerUrl = new URL(process.argv[3] ?? '');
assert.equal(brokerUrl.protocol, 'ws:', 'Expected a ws:// broker URL');

// Bundle a copy inside the consumer, so mqtt/browser resolves to the installed tarball.
const entry = resolve(root, 'packed/page-lifecycle-page.ts');
mkdirSync(resolve(root, 'packed'), { recursive: true });
cpSync(new URL('./page-lifecycle-page.ts', import.meta.url), entry);
const result = await build({
  root,
  configFile: false,
  logLevel: 'silent',
  build: { write: false, lib: { entry, formats: ['es'] } },
});
const chunks = [];
for (const bundle of Array.isArray(result) ? result : [result]) {
  if (!('output' in bundle)) throw new Error('Unexpected Vite watcher');
  for (const output of bundle.output) if (output.type === 'chunk') chunks.push(output.code);
}
const [code] = chunks;
assert.ok(chunks.length === 1 && code !== undefined);

interface Pair {
  readonly client: Socket;
  readonly upstream: Socket;
  stalled: boolean;
}
const pairs = new Set<Pair>();
let opened = 0;
let lastClosedAt = 0;
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The connection listener of createServer in node:net receives a native net.Socket, and the proxy calls its write and destroy methods.
const proxy = createTcpServer((client) => {
  opened++;
  const upstream = connect(Number(brokerUrl.port), brokerUrl.hostname);
  const pair: Pair = { client, upstream, stalled: false };
  pairs.add(pair);
  const close = () => {
    client.destroy();
    upstream.destroy();
    if (pairs.delete(pair)) lastClosedAt = performance.now();
  };
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- A net.Socket data event passes a native Buffer, which the proxy writes on unchanged.
  client.on('data', (bytes: Buffer) => {
    if (!pair.stalled) upstream.write(bytes);
  });
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- A net.Socket data event passes a native Buffer, which the proxy writes on unchanged.
  upstream.on('data', (bytes: Buffer) => {
    if (!pair.stalled) client.write(bytes);
  });
  client.on('error', close).on('close', close);
  upstream.on('error', close).on('close', close);
});
proxy.listen(0, '127.0.0.1');
await once(proxy, 'listening');
const proxyAddress = proxy.address();
assert.ok(proxyAddress !== null && typeof proxyAddress !== 'string');
const proxyUrl = `ws://127.0.0.1:${String(proxyAddress.port)}${brokerUrl.pathname}`;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The request listener of createServer in node:http receives a native http.IncomingMessage and http.ServerResponse, and the fixture calls the response's writeHead and end methods.
const server = createServer((request, response) => {
  if (request.url === '/lifecycle.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
  else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>' + String(request.url) + '</title>');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address !== null && typeof address !== 'string');
const origin = `http://127.0.0.1:${String(address.port)}`;
const engines = process.argv.slice(4);
if (engines.length === 0) engines.push('chromium');

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for ' + what);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

async function start(): Promise<void> {
  const page = tab();
  await page.evaluate(
    async ({ url, clientId }: Readonly<{ url: string; clientId: string }>) => (await import('/lifecycle.js')).start(url, clientId),
    { url: proxyUrl, clientId: `packed-lifecycle-${String(process.pid)}` },
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

// Chromium restores the page from the back-forward cache, keeps its connection open in the cache and fails its WebSocket
// on restore. Firefox and WebKit navigation is reported and not asserted.
async function navigate(engine: string, notCached: readonly unknown[]): Promise<void> {
  const page = tab();
  const before = opened;
  const left = performance.now();
  await page.goto(origin + '/b');
  await sleep(2000);
  const openInCache = pairs.size;
  const closedAfterMs = openInCache === 0 ? Math.round(lastClosedAt - left) : undefined;
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState === 'complete');
  if (engine !== 'chromium') {
    const restored = (await entries()).includes('pageshow persisted=true');
    if (restored) await until('return ', 10_000);
    else await start();
    // A return can be logged before its reconnect connects, so the next step reads the generation of a connected session.
    await ready();
    console.log(
      JSON.stringify({
        engine,
        version: browser().version(),
        restoredFromCache: restored,
        connectionsOpenInCache: openInCache,
        closedAfterMs,
        connectionsOpened: opened - before,
        timeline: await timeline(),
      }),
    );
    return;
  }
  assert.equal(openInCache, 1, 'The connection of the cached page stays open');
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
  await waitFor(() => pairs.size === 1, 'the connection of the cached page to close');
  assert.ok(restoredMs < 5000);
  assert.equal(opened - before, 1);
  console.log(`Chromium ${browser().version()} restored the page from the back-forward cache and reconnected at once`);
  console.log(JSON.stringify(log));
}

async function check(engine: string): Promise<void> {
  const page = tab();
  const notCached: unknown[] = [];
  if (engine === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.enable');
    cdp.on('Page.backForwardCacheNotUsed', (event: Readonly<{ notRestoredExplanations: readonly unknown[] }>) => {
      notCached.push(event.notRestoredExplanations);
    });
  }
  const before = opened;
  await page.goto(origin + '/a');
  await start();
  assert.equal(opened - before, 1);
  await navigate(engine, notCached);

  let session = await generation();
  let known = returns(await entries()).length;
  let connections = opened;
  for (const pair of pairs) pair.stalled = true;
  await setVisibility('hidden');
  await setVisibility('visible');
  const stalledMs = await until(`connected ${String(session + 1)} ERR_MQTT_TIMEOUT`);
  assert.ok(stalledMs >= 900 && stalledMs < 3000, `Reconnected after ${String(stalledMs)} ms`);
  await until('return ');
  assert.deepEqual(returns(await entries()).slice(known), ['return visibilitychange retried']);
  assert.equal(opened - connections, 1);
  console.log(
    `${engine}: a silent connection ended at its ping deadline, and the next session connected ${String(Math.round(stalledMs))} ms after the return`,
  );

  session = await generation();
  known = returns(await entries()).length;
  connections = opened;
  for (const pair of pairs) pair.stalled = true;
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
  assert.equal(opened - connections, 1);
  console.log(
    `${engine}: a pending QoS 1 publication rejected after ${String(Math.round(pending.elapsedMs))} ms, and the return reconnected at once`,
  );

  known = returns(await entries()).length;
  connections = opened;
  await page.evaluate(async () => {
    (await import('/lifecycle.js')).dispatchRestore();
  });
  await until('return pageshow');
  await sleep(500);
  assert.deepEqual(returns(await entries()).slice(known), ['return pageshow answered']);
  assert.equal(opened, connections);
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
      throw error;
    } finally {
      active = undefined;
      await current.close();
      current = undefined;
    }
    await waitFor(() => pairs.size === 0, 'the connections of ' + engine + ' to close');
  }
} finally {
  server.close();
  proxy.close();
  for (const pair of pairs) {
    pair.client.destroy();
    pair.upstream.destroy();
  }
}
