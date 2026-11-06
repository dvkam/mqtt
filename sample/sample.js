import { once } from 'node:events';
import { createServer } from 'node:net';
import { Aedes } from 'aedes';
import { connect } from '../dist/index.js';

const broker = await Aedes.createBroker();
const server = createServer(broker.handle);
server.listen(0, '127.0.0.1');
try {
  await once(server, 'listening');
  const { port } = server.address();
  const client = await connect({ brokerUrl: new URL('mqtt://127.0.0.1:' + port), protocolVersion: 4 });
  try {
    await client.publish({ topic: 'example/hello', payload: 'hello' });
  } finally {
    await client.disconnect();
  }
} finally {
  await new Promise((resolve) => broker.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
