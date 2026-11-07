import { connect, createTcpClient, createWebSocketClient } from 'mqtt';
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
  const tcp = createTcpClient({
    host: '127.0.0.1',
    clientId: 'consumer',
    signal,
    onMessage(packet) {
      packet.payload.toString();
    },
  });
  const connected = await tcp.connect();
  await connected.ping();
  await connected.disconnect();
}

export async function checkWebSocketDeclarations(signal: AbortSignal) {
  const factory = createWebSocketClient({
    url: new URL('wss://localhost/mqtt'),
    clientId: 'consumer',
    signal,
    onMessage(packet) {
      packet.payload.toString();
    },
  });
  const client = await factory.connect();
  await client.ping();
  await client.disconnect();
}
import { createBrowserClient, openBrowserTransport } from 'mqtt/browser';

export async function checkBrowserClientDeclarations(signal: AbortSignal) {
  const client = await createBrowserClient({
    url: 'wss://localhost/mqtt',
    clientId: 'consumer',
    signal,
    onMessage(message) {
      const bytes: Uint8Array = message.payload;
      bytes.byteLength.toFixed();
    },
  }).connect();
  await client.subscribe('a');
  await client.publish('a', 'hello');
  await client.ping();
  await client.disconnect();
}
import { encodePacket, PacketDecoder } from 'mqtt/codec';

export function checkCodecDeclarations() {
  const bytes: Uint8Array = encodePacket({ cmd: 'connect', clientId: 'consumer' });
  return new PacketDecoder({ maxPacketBytes: 4096 }).push(bytes);
}

export async function checkBrowserTransportDeclarations(signal: AbortSignal) {
  const transport = await openBrowserTransport('wss://localhost/mqtt', {
    signal,
    onBytes(bytes) {
      bytes.byteLength.toFixed();
    },
    onClose(reason) {
      reason.message.toLowerCase();
    },
  });
  transport.send(Uint8Array.of(0xc0, 0));
  await transport.close();
}
