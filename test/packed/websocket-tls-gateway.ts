import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createServer } from 'node:tls';

const [certificatePath, keyPath] = process.argv.slice(2);
assert.ok(certificatePath !== undefined && keyPath !== undefined, 'Expected certificate and key paths');
const server = createServer(
  {
    cert: readFileSync(certificatePath),
    key: readFileSync(keyPath),
    ALPNProtocols: ['http/1.1'],
  },
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Piping and destroying the real TLSSocket exercise the gateway's duplex shutdown behavior.
  (client) => {
    const broker = createConnection(18884, '127.0.0.1');
    client.on('error', () => {
      broker.destroy();
    });
    broker.on('error', () => {
      client.destroy();
    });
    client.on('close', () => {
      broker.destroy();
    });
    broker.on('close', () => {
      client.destroy();
    });
    client.pipe(broker).pipe(client);
  },
);
server.listen(18887, '127.0.0.1');
