import { connect, createTcpClient, createWebSocketClient } from 'mqtt';
export type { ConnectOptions, LegacyAckCompletion, LegacyAckHandler, PacketIdentifier, PacketLookup, PacketStore } from 'mqtt';
export type { ClientFactory, ClientSession, NodeMessage, TcpClientOptions, WebSocketClientOptions } from 'mqtt';
export type { BrowserClientOptions, ClientFactory as BrowserFactory, ClientSession as BrowserClientSession } from 'mqtt/browser';
import { connectPortable, type PacketTransport } from 'mqtt/portable';

type RequireTrue<Value extends true> = Value;
type RequireFalse<Value extends false> = Value;
type IsAny<Value> = 0 extends 1 & Value ? true : false;
type Received = Parameters<NonNullable<import('mqtt').TcpClientOptions['onMessage']>>[0];
export type PackedPayloadIsSpecific = RequireFalse<IsAny<Received['payload']>>;
export type PackedPayloadIsBuffer = RequireTrue<Received['payload'] extends Buffer ? true : false>;
export type PackedQosIsZero = RequireTrue<Received['qos'] extends 0 ? true : false>;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
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

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
export async function checkTcpDeclarations(signal: AbortSignal) {
  const tcp = createTcpClient({
    host: '127.0.0.1',
    maxPacketBytes: 4096,
    clientId: 'consumer',
    signal,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onMessage(packet) {
      const payload: Buffer = packet.payload;
      payload[0] = packet.qos;
    },
  });
  const connected = await tcp.connect();
  await connected.ping();
  await connected.disconnect();
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
export async function checkWebSocketDeclarations(signal: AbortSignal) {
  const factory = createWebSocketClient({
    url: new URL('wss://localhost/mqtt'),
    clientId: 'consumer',
    maxWebSocketMessageBytes: 4096,
    signal,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onMessage(packet) {
      const payload: Buffer = packet.payload;
      payload[0] = packet.qos;
    },
  });
  const client = await factory.connect();
  await client.ping();
  await client.disconnect();
}
import { createBrowserClient, openBrowserTransport } from 'mqtt/browser';

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
export async function checkBrowserClientDeclarations(signal: AbortSignal) {
  const client = await createBrowserClient({
    url: 'wss://localhost/mqtt',
    clientId: 'consumer',
    maxWebSocketMessageBytes: 4096,
    signal,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
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
  const decoder = new PacketDecoder({ maxPacketBytes: 4096 });
  const packets = decoder.push(bytes);
  decoder.finish();
  return packets;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
export async function checkBrowserTransportDeclarations(signal: AbortSignal) {
  const transport = await openBrowserTransport('wss://localhost/mqtt', {
    signal,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onBytes(bytes) {
      bytes.byteLength.toFixed();
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onClose(reason) {
      reason.message.toLowerCase();
    },
  });
  transport.send(Uint8Array.of(0xc0, 0));
  await transport.close();
}
