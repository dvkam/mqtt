import { connect, createTcpClient } from 'mqtt';
import { connectPortable, type PacketTransport } from 'mqtt/portable';

export async function checkDeclarations(transport: PacketTransport) {
  const legacy = await connect({ brokerUrl: new URL('mqtt://localhost') });
  await legacy.disconnect();

  const portable = await connectPortable(transport, { clientId: 'consumer' });
  await portable.subscribe('consumer/test');
  await portable.publish('consumer/test', 'hello');
  // @ts-expect-error The experimental tracer accepts string payloads.
  await portable.publish('consumer/test', 42);
  await portable.disconnect();
}

export async function checkTcpDeclarations(signal: AbortSignal) {
  const tcp = createTcpClient({ host: '127.0.0.1', clientId: 'consumer', signal });
  const connected = await tcp.connect();
  await connected.ping();
  await connected.disconnect();
}
