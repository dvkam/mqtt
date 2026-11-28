import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cpSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { build } from 'vite';

/** What the page at /auto posts once its client connected. */
export interface Report {
  readonly wasDiscarded: boolean;
  readonly entries: readonly string[];
}

/** What the proxy does with a new connection: pass it on, accept it and stay silent, or close it at once. */
export type Mode = 'forward' | 'silent' | 'refuse';

export interface Fixture {
  /**
   * The origin of the HTTP server. /auto starts a client on load, /manual starts one and shows its log, and every other
   * path is an empty page.
   */
  readonly origin: string;
  /** The WebSocket URL of the proxy in front of the broker. */
  readonly proxyUrl: string;
  readonly clientId: string;
  /** The number of connections the proxy accepted, in every mode. */
  readonly opened: () => number;
  /**
   * Waits 300 milliseconds and returns the number of connections accepted since the count `since`. A second attempt
   * that starts together with the first opens its connection within that wait. A retry timer that the client did not
   * clear would run 10 to 20 seconds later, and test/reconnect.test.ts covers that with fake timers.
   */
  readonly openedSince: (since: number) => Promise<number>;
  /** The number of connections that are open now. */
  readonly open: () => number;
  /** The `performance.now()` of the last accepted connection. */
  readonly openedAt: () => number;
  /** The `performance.now()` of the last closed connection. */
  readonly closedAt: () => number;
  /** How long each closed connection was open, in milliseconds, in the order they closed. */
  readonly durations: () => readonly number[];
  /** Stops passing on bytes of the open connections, in both directions. */
  readonly stall: () => void;
  /** Closes the open connections. */
  readonly drop: () => void;
  readonly setMode: (mode: Mode) => void;
  readonly reports: () => readonly Report[];
  /** The page events that /auto sent with `navigator.sendBeacon`. */
  readonly beacons: () => readonly string[];
  readonly close: () => void;
}

interface Pair {
  readonly acceptedAt: number;
  readonly client: Socket;
  readonly upstream: Socket;
  stalled: boolean;
}

function isReport(value: unknown): value is Report {
  if (typeof value !== 'object' || value === null || !('wasDiscarded' in value) || !('entries' in value)) return false;
  const { wasDiscarded, entries } = value;
  return typeof wasDiscarded === 'boolean' && Array.isArray(entries) && entries.every((entry) => typeof entry === 'string');
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<number> {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > timeoutMs) throw new Error('Timed out waiting for ' + what);
    await sleep(10);
  }
  return performance.now() - started;
}

/**
 * Bundles the page module against the packed tarball in `root`, and starts an HTTP server for it and a TCP proxy in
 * front of the broker at `brokerUrl`. The proxy counts connections and can make them stop answering. Both listen on
 * `host`, which is the loopback address unless another device has to reach them.
 */
export async function createFixture(
  root: string,
  brokerUrl: Readonly<{ hostname: string; port: string; pathname: string }>,
  host = '127.0.0.1',
): Promise<Fixture> {
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

  const pairs = new Set<Pair>();
  let mode: Mode = 'forward';
  let opened = 0;
  let openedAt = 0;
  let closedAt = 0;
  const durations: number[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The connection listener of createServer in node:net receives a native net.Socket, and the proxy calls its write and destroy methods.
  const proxy = createTcpServer((client) => {
    opened++;
    openedAt = performance.now();
    if (mode === 'refuse') {
      closedAt = openedAt;
      client.destroy();
      return;
    }
    const upstream = connect(Number(brokerUrl.port), brokerUrl.hostname);
    const pair: Pair = { acceptedAt: openedAt, client, upstream, stalled: mode === 'silent' };
    pairs.add(pair);
    const close = () => {
      client.destroy();
      upstream.destroy();
      if (!pairs.delete(pair)) return;
      closedAt = performance.now();
      durations.push(closedAt - pair.acceptedAt);
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
  proxy.listen(0, host);
  await once(proxy, 'listening');
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress !== null && typeof proxyAddress !== 'string');
  const proxyUrl = `ws://127.0.0.1:${String(proxyAddress.port)}${brokerUrl.pathname}`;
  const clientId = `packed-lifecycle-${String(process.pid)}`;

  const reports: Report[] = [];
  const beacons: string[] = [];
  const auto = `<!doctype html><title>auto</title><script type="module">
import { start, entries } from '/lifecycle.js';
const send = (type) => navigator.sendBeacon('/beacon', type + ' ' + document.visibilityState);
addEventListener('pagehide', (event) => send('pagehide persisted=' + event.persisted));
for (const type of ['freeze', 'visibilitychange']) document.addEventListener(type, () => send(type));
await start(${JSON.stringify(proxyUrl)}, ${JSON.stringify(clientId)});
await fetch('/report', { method: 'POST', body: JSON.stringify({ wasDiscarded: document.wasDiscarded, entries: entries() }) });
</script>`;
  // The page is loaded from another device, so it takes the host of the proxy from its own address.
  const manual = `<!doctype html><meta name="viewport" content="width=device-width"><title>MQTT page lifecycle</title>
<pre id="log"></pre><script type="module">
import { start, timeline } from '/lifecycle.js';
const show = () => {
  const now = Math.round(performance.now()) + ' now ' + document.visibilityState;
  document.getElementById('log').textContent = [...timeline(), now].join('\\n');
};
setInterval(show, 500);
const url = 'ws://' + location.hostname + ':' + ${JSON.stringify(String(proxyAddress.port) + brokerUrl.pathname)};
await start(url, 'manual-lifecycle-' + Math.random().toString(16).slice(2, 8));
</script>`;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The request listener of createServer in node:http receives a native http.IncomingMessage and http.ServerResponse, and the fixture reads the request's stream and calls the response's writeHead and end methods.
  const server = createServer((request, response) => {
    if (request.url === '/lifecycle.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
    else if (request.url === '/auto') response.writeHead(200, { 'Content-Type': 'text/html' }).end(auto);
    else if (request.url === '/manual') response.writeHead(200, { 'Content-Type': 'text/html' }).end(manual);
    else if (request.url === '/report' || request.url === '/beacon') {
      const { url } = request;
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (text: string) => {
        body += text;
      });
      request.on('end', () => {
        if (url === '/beacon') beacons.push(body);
        else {
          const report: unknown = JSON.parse(body);
          assert.ok(isReport(report), body);
          reports.push(report);
        }
        response.writeHead(204).end();
      });
    } else
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>' + String(request.url) + '</title>');
  });
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    proxyUrl,
    clientId,
    opened: () => opened,
    async openedSince(since) {
      await sleep(300);
      return opened - since;
    },
    open: () => pairs.size,
    openedAt: () => openedAt,
    closedAt: () => closedAt,
    durations: () => durations,
    stall() {
      for (const pair of pairs) pair.stalled = true;
    },
    drop() {
      for (const pair of pairs) pair.client.destroy();
    },
    setMode(next) {
      mode = next;
    },
    reports: () => reports,
    beacons: () => beacons,
    close() {
      server.close();
      proxy.close();
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
    },
  };
}
