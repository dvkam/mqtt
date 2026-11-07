import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

const [consumer, ca] = process.argv.slice(2);
const targets = new Set(['localhost:18885', 'localhost:18887']);
const sockets = new Set();
let tunnels = 0;
const proxy = createServer((_request, response) => response.writeHead(405).end());
proxy.on('connect', (request, client, head) => {
  if (!targets.has(request.url)) {
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  tunnels++;
  const upstream = createConnection(Number(request.url.split(':')[1]), '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  sockets.add(client);
  sockets.add(upstream);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
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
  const address = 'http://127.0.0.1:' + proxy.address().port;
  /** @type {[entry: string, args: string[], env: NodeJS.ProcessEnv, sessions: number][]} */
  const cases = [
    [
      resolve(consumer, 'broker.mjs'),
      [],
      {
        MQTT_TEST_WS_URL: 'wss://localhost:18885/mqtt',
        MQTT_TEST_CA: ca,
        MQTT_TEST_PROXY: address,
      },
      1,
    ],
    [
      resolve('test/packed/websocket-session-check.mjs'),
      [consumer, 'wss://localhost:18887/mqtt'],
      {
        NODE_USE_ENV_PROXY: '1',
        HTTPS_PROXY: address,
        https_proxy: address,
        NO_PROXY: '',
        no_proxy: '',
        NODE_EXTRA_CA_CERTS: ca,
      },
      2,
    ],
  ];
  if (process.env.MQTT_CHROMIUM_HOME) {
    cases.push([
      resolve('test/packed/websocket-session-check.mjs'),
      [consumer, 'wss://localhost:18887/mqtt', 'chromium'],
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
    const [status] = await once(child, 'exit');
    assert.equal(status, 0);
    assert.equal(tunnels, before + sessions, 'Expected every session to use the CONNECT proxy');
  }
  console.log(cases.length + ' clients used the WSS CONNECT proxy');
} finally {
  for (const socket of sockets) socket.destroy();
  proxy.close();
}
