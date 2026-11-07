import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createServer } from 'node:tls';

const [cert, key] = process.argv.slice(2);
const server = createServer(
  {
    cert: readFileSync(cert),
    key: readFileSync(key),
    ALPNProtocols: ['http/1.1'],
  },
  (client) => {
    const broker = createConnection(18884, '127.0.0.1');
    client.on('error', () => broker.destroy());
    broker.on('error', () => client.destroy());
    client.on('close', () => broker.destroy());
    broker.on('close', () => client.destroy());
    client.pipe(broker).pipe(client);
  },
);
server.listen(18887, '127.0.0.1');
