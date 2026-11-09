import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import type { Duplex } from 'node:stream';

const [consumerDirectory, certificateAuthorityPath] = process.argv.slice(2);
assert.ok(consumerDirectory !== undefined && certificateAuthorityPath !== undefined, 'Expected consumer and CA paths');
const targets = new Set(['localhost:18885', 'localhost:18887']);
const sockets = new Set<Duplex>();
let tunnels = 0;
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The proxy writes and ends the native HTTP response.
const proxy = createServer((_request, response) => {
  response.writeHead(405).end();
});
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The proxy writes, pipes and destroys the original CONNECT socket, including its first buffered bytes.
proxy.on('connect', (request, client, head) => {
  if (!targets.has(request.url ?? '')) {
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  tunnels++;
  const upstream = createConnection(Number((request.url ?? '').split(':')[1]), '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  sockets.add(client);
  sockets.add(upstream);
  client.on('error', () => {
    upstream.destroy();
  });
  upstream.on('error', () => {
    client.destroy();
  });
  client.on('close', () => {
    sockets.delete(client);
    upstream.destroy();
  });
  upstream.on('close', () => {
    sockets.delete(upstream);
    client.destroy();
  });
});
proxy.listen(0, '127.0.0.1');
await once(proxy, 'listening');
try {
  const endpoint = proxy.address();
  assert.ok(endpoint !== null && typeof endpoint !== 'string');
  const address = 'http://127.0.0.1:' + endpoint.port;
  const cases: [entry: string, args: string[], env: NodeJS.ProcessEnv, sessions: number][] = [
    [
      resolve(consumerDirectory, 'broker.mjs'),
      [],
      {
        MQTT_TEST_WS_URL: 'wss://localhost:18885/mqtt',
        MQTT_TEST_CA: certificateAuthorityPath,
        MQTT_TEST_PROXY: address,
      },
      1,
    ],
    [
      resolve('test/packed/websocket-session-check.ts'),
      [consumerDirectory, 'wss://localhost:18887/mqtt'],
      {
        NODE_USE_ENV_PROXY: '1',
        HTTPS_PROXY: address,
        https_proxy: address,
        NO_PROXY: '',
        no_proxy: '',
        NODE_EXTRA_CA_CERTS: certificateAuthorityPath,
      },
      2,
    ],
  ];
  if (process.env['MQTT_CHROMIUM_HOME'] !== undefined && process.env['MQTT_CHROMIUM_HOME'] !== '') {
    cases.push([
      resolve('test/packed/websocket-session-check.ts'),
      [consumerDirectory, 'wss://localhost:18887/mqtt', 'chromium'],
      { MQTT_CHROMIUM_PROXY: address },
      2,
    ]);
  }
  for (const [entry, args, env, sessions] of cases) {
    const before = tunnels;
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
      timeout: 12_000,
    });
    const exitEvent: unknown[] = await once(child, 'exit');
    const [status] = exitEvent;
    assert.equal(status, 0);
    assert.equal(tunnels, before + sessions, 'Expected every session to use the CONNECT proxy');
  }
  console.log(cases.length + ' clients used the WSS CONNECT proxy');
} finally {
  for (const socket of sockets) socket.destroy();
  proxy.close();
}
