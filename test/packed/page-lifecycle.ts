import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cpSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
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
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The connection listener of createServer in node:net receives a native net.Socket, and the proxy calls its write and destroy methods.
const proxy = createTcpServer((client) => {
  opened++;
  const upstream = connect(Number(brokerUrl.port), brokerUrl.hostname);
  const pair: Pair = { client, upstream, stalled: false };
  pairs.add(pair);
  const close = () => {
    client.destroy();
    upstream.destroy();
    pairs.delete(pair);
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

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture writes and ends the native HTTP response.
const server = createServer((request, response) => {
  if (request.url === '/lifecycle.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
  else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>' + String(request.url) + '</title>');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address !== null && typeof address !== 'string');
const origin = `http://127.0.0.1:${String(address.port)}`;

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for ' + what);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

// Playwright starts Chromium with --disable-back-forward-cache, and the headless shell refuses the cache with
// BackForwardCacheDisabledForDelegate. The full Chromium build in new headless mode keeps the page in the cache.
const browser = await chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] });
try {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  const notCached: unknown[] = [];
  cdp.on('Page.backForwardCacheNotUsed', (event: Readonly<{ notRestoredExplanations: readonly unknown[] }>) => {
    notCached.push(event.notRestoredExplanations);
  });
  await page.goto(origin + '/a');
  await page.evaluate(
    async ({ url, clientId }: Readonly<{ url: string; clientId: string }>) => (await import('/lifecycle.js')).start(url, clientId),
    { url: proxyUrl, clientId: `packed-lifecycle-${String(process.pid)}` },
  );
  assert.equal(opened, 1);

  // A real navigation away and back. Chromium keeps the cached page's connection open, and fails its WebSocket on restore.
  await page.goto(origin + '/b');
  await new Promise((resolve) => {
    setTimeout(resolve, 2000);
  });
  assert.equal(pairs.size, 1, 'The connection of the cached page stays open');
  await page.goBack({ waitUntil: 'commit' });
  const restoredMs = await page.evaluate(async () => (await import('/lifecycle.js')).until('connected 2'));
  assert.deepEqual(notCached, []);
  const restored = await page.evaluate(async () => (await import('/lifecycle.js')).entries());
  for (const expected of ['pagehide persisted=true', 'freeze hidden', 'resume hidden', 'pageshow persisted=true'])
    assert.ok(restored.includes(expected), `Expected "${expected}" in ${JSON.stringify(restored)}`);
  assert.ok(restored.includes('return resume retried'), JSON.stringify(restored));
  assert.ok(
    restored.some((entry) => /^retrying \d+ MQTT WebSocket failed$/u.test(entry)),
    JSON.stringify(restored),
  );
  await waitFor(() => pairs.size === 1, 'the connection of the cached page to close');
  assert.ok(restoredMs < 5000);
  assert.equal(opened, 2);
  console.log(`Chromium ${browser.version()} restored the page from the back-forward cache and reconnected at once`);
  console.log(JSON.stringify(restored));

  for (const pair of pairs) pair.stalled = true;
  await page.evaluate(async () => {
    (await import('/lifecycle.js')).setVisibility('hidden');
  });
  await page.evaluate(async () => {
    (await import('/lifecycle.js')).setVisibility('visible');
  });
  const stalledMs = await page.evaluate(async () => (await import('/lifecycle.js')).until('connected 3 ERR_MQTT_TIMEOUT'));
  assert.ok(stalledMs >= 900 && stalledMs < 3000, `Reconnected after ${String(stalledMs)} ms`);
  assert.ok(
    (await page.evaluate(async () => (await import('/lifecycle.js')).entries())).includes('return visibilitychange retried'),
  );
  assert.equal(opened, 3);
  console.log(
    `A silent connection ended at its ping deadline, and the next session connected ${String(Math.round(stalledMs))} ms after the return`,
  );

  for (const pair of pairs) pair.stalled = true;
  await page.evaluate(async () => {
    (await import('/lifecycle.js')).setVisibility('hidden');
  });
  const pending = await page.evaluate(
    async (topic) => (await import('/lifecycle.js')).publishPending(topic),
    `ci/lifecycle/${String(process.pid)}`,
  );
  assert.equal(pending.code, 'ERR_MQTT_TIMEOUT');
  assert.ok(pending.elapsedMs >= 900 && pending.elapsedMs < 2000, `Settled after ${String(pending.elapsedMs)} ms`);
  await page.evaluate(async () => (await import('/lifecycle.js')).until('retrying'));
  await page.evaluate(async () => {
    (await import('/lifecycle.js')).setVisibility('visible');
  });
  await page.evaluate(async () => (await import('/lifecycle.js')).until('connected 4 ERR_MQTT_TIMEOUT uncertain=1', 3000));
  assert.equal(opened, 4);
  console.log(
    `A pending QoS 1 publication rejected after ${String(Math.round(pending.elapsedMs))} ms, and the return reconnected at once`,
  );

  await page.evaluate(async () => {
    (await import('/lifecycle.js')).dispatchRestore();
  });
  await page.evaluate(async () => (await import('/lifecycle.js')).until('return pageshow answered'));
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
  const final = await page.evaluate(async () => (await import('/lifecycle.js')).entries());
  assert.equal(final.filter((entry) => entry.startsWith('connected')).length, 4);
  assert.equal(opened, 4);
  await page.evaluate(async () => {
    await (await import('/lifecycle.js')).stop();
  });
  console.log('Packed Chromium page lifecycle check passed');
} finally {
  await browser.close();
  server.close();
  proxy.close();
  for (const pair of pairs) {
    pair.client.destroy();
    pair.upstream.destroy();
  }
}
