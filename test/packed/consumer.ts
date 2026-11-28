import {
  createTcpClient,
  createTransportClient,
  type ByteTransport,
  type ClientDiagnostic,
  type ConnectionInfo,
  type DiagnosticObserver,
  type DisconnectOptions,
  type NodeQosOneMessage,
  type NodeQosTwoMessage,
  type ReconnectEvent,
  type SessionEnd,
  type SubscribeResult,
  type UnsubscribeResult,
  type WillOptions,
} from 'mqtt';
import { createWebSocketClient } from 'mqtt/ws';
export type { ClientFactory, ClientSession, NodeMessage, PublishOptions, TcpClientOptions } from 'mqtt';
export type { WebSocketClientOptions } from 'mqtt/ws';
export type { BrowserClientOptions, ClientFactory as BrowserFactory, ClientSession as BrowserClientSession } from 'mqtt/browser';
import type { ProtocolInputCode, ProtocolInputError } from 'mqtt/portable';

type RequireTrue<Value extends true> = Value;
type RequireFalse<Value extends false> = Value;
type IsAny<Value> = 0 extends 1 & Value ? true : false;
type EndNotice = Parameters<NonNullable<import('mqtt').TcpClientOptions['onSessionEnd']>>[0];
type WebSocketEndNotice = Parameters<NonNullable<import('mqtt/ws').WebSocketClientOptions['onSessionEnd']>>[0];
export type TcpEndNoticeIsSpecific = RequireFalse<IsAny<EndNotice>>;
export type WebSocketEndNoticeIsSpecific = RequireFalse<IsAny<WebSocketEndNotice>>;
export type TcpEndNoticeUsesNamedType = RequireTrue<EndNotice extends SessionEnd ? true : false>;
export type WebSocketEndNoticeUsesNamedType = RequireTrue<WebSocketEndNotice extends SessionEnd ? true : false>;
type Received = Parameters<NonNullable<import('mqtt').TcpClientOptions['onMessage']>>[0];
export type PackedPayloadIsSpecific = RequireFalse<IsAny<Received['payload']>>;
export type PackedPayloadIsBuffer = RequireTrue<Received['payload'] extends Buffer ? true : false>;
export type PackedQosIsZero = RequireTrue<Received['qos'] extends 0 ? true : false>;
export type PackedMessageIsFlat = RequireFalse<'properties' extends keyof Received ? true : false>;
export type PackedMessageNamesItsProperties = RequireTrue<Received extends import('mqtt').MessageProperties ? true : false>;
export type PackedUserPropertiesAreOrderedPairs = RequireTrue<
  NonNullable<Received['userProperties']> extends readonly import('mqtt').UserProperty[] ? true : false
>;
type NodeQosOne = Parameters<NonNullable<import('mqtt').TcpClientOptions['onQosOneMessage']>>[0];
type BrowserQosOne = Parameters<NonNullable<import('mqtt/browser').BrowserClientOptions['onQosOneMessage']>>[0];
export type NodeQosOnePayloadIsSpecific = RequireFalse<IsAny<NodeQosOne['payload']>>;
export type NodeQosOnePayloadIsBuffer = RequireTrue<NodeQosOne['payload'] extends Buffer ? true : false>;
export type BrowserQosOnePayloadIsSpecific = RequireFalse<IsAny<BrowserQosOne['payload']>>;
export type BrowserQosOnePayloadIsBytes = RequireTrue<BrowserQosOne['payload'] extends Uint8Array ? true : false>;
export type QosOneHasIdentifier = RequireTrue<(NodeQosOne | BrowserQosOne)['messageId'] extends number ? true : false>;
export type QosOneIsOne = RequireTrue<(NodeQosOne | BrowserQosOne)['qos'] extends 1 ? true : false>;
export type NodeQosOneCallbackUsesNamedMessage = RequireTrue<NodeQosOne extends NodeQosOneMessage ? true : false>;
export type NamedNodeQosOneMatchesCallback = RequireTrue<NodeQosOneMessage extends NodeQosOne ? true : false>;
type NodeQosTwo = Parameters<NonNullable<import('mqtt').TcpClientOptions['onQosTwoMessage']>>[0];
type BrowserQosTwo = Parameters<NonNullable<import('mqtt/browser').BrowserClientOptions['onQosTwoMessage']>>[0];
export type NodeQosTwoPayloadIsBuffer = RequireTrue<NodeQosTwo['payload'] extends Buffer ? true : false>;
export type BrowserQosTwoPayloadIsSpecific = RequireFalse<IsAny<BrowserQosTwo['payload']>>;
export type BrowserQosTwoPayloadIsBytes = RequireTrue<BrowserQosTwo['payload'] extends Uint8Array ? true : false>;
export type QosTwoHasIdentifier = RequireTrue<(NodeQosTwo | BrowserQosTwo)['messageId'] extends number ? true : false>;
export type QosTwoIsTwo = RequireTrue<(NodeQosTwo | BrowserQosTwo)['qos'] extends 2 ? true : false>;
export type NodeQosTwoCallbackUsesNamedMessage = RequireTrue<NodeQosTwo extends NodeQosTwoMessage ? true : false>;
export type NamedNodeQosTwoMatchesCallback = RequireTrue<NodeQosTwoMessage extends NodeQosTwo ? true : false>;
export type BrowserQosTwoUsesNamedMessage = RequireTrue<
  BrowserQosTwo extends import('mqtt/browser').BrowserQosTwoMessage ? true : false
>;
export type SubscribeGrantsUpToQosTwo = RequireTrue<0 | 1 | 2 extends SubscribeResult['grantedQos'] ? true : false>;
type Uncertain = NonNullable<Extract<SessionEnd, { kind: 'error' }>['uncertain']>[number];
export type UncertainNamesItsQos = RequireTrue<Uncertain['qos'] extends 1 | 2 ? true : false>;
export type ReconnectReportsEachAcknowledgment = RequireTrue<
  'puback' | 'pubrec' | 'pubcomp' extends ReconnectEvent['kind'] ? true : false
>;
export type ProtocolInputCodeIsSpecific = RequireFalse<IsAny<ProtocolInputCode>>;
export type ProtocolInputCodeIsBounded = RequireTrue<ProtocolInputCode extends 0x81 | 0x82 | 0x94 ? true : false>;
export type ProtocolInputCodeIsComplete = RequireTrue<0x81 | 0x82 | 0x94 extends ProtocolInputCode ? true : false>;
export type TransportProtocolCodeUsesNamedType = RequireTrue<
  ProtocolInputError['reasonCode'] extends ProtocolInputCode ? true : false
>;
export type ProtocolInputErrorIsCoded = RequireTrue<ProtocolInputError['code'] extends 'ERR_MQTT_PROTOCOL' ? true : false>;
type TransportPayload = Parameters<NonNullable<Parameters<typeof createTransportClient>[1]['onMessage']>>[0]['payload'];
export type TransportPayloadIsSpecific = RequireFalse<IsAny<TransportPayload>>;
export type TransportPayloadIsBuffer = RequireTrue<TransportPayload extends Buffer ? true : false>;

export async function checkDeclarations(transport: Readonly<ByteTransport>) {
  const will: WillOptions = { topic: 'consumer/status', payload: Buffer.from('offline'), qos: 1 };
  const portable = await createTransportClient(transport, { clientId: 'consumer', will }).connect();
  const connection: ConnectionInfo = portable.connection;
  const subscribed: SubscribeResult = await portable.subscribe('consumer/test');
  const unsubscribed: UnsubscribeResult = await portable.unsubscribe('consumer/test');
  await portable.publish('consumer/test', 'hello');
  // @ts-expect-error The client accepts string payloads.
  await portable.publish('consumer/test', 42);
  const options: DisconnectOptions = { drainTimeoutMs: 1000, reasonCode: 4 };
  await portable.disconnect(options);
  // @ts-expect-error The client only sends normal disconnection or disconnection with Will.
  await portable.disconnect({ reasonCode: 1 });
  return { connection, grantedQos: subscribed.grantedQos, reasonCode: unsubscribed.reasonCode };
}

export function checkWillOptionTypes() {
  const options = { host: 'localhost', clientId: 'will-consumer' };
  createTcpClient({ ...options, will: { topic: 'status', payload: 'offline', qos: 2 } });
  // @ts-expect-error The Will requires text or a Uint8Array.
  createTcpClient({ ...options, will: { topic: 'status', payload: 12 } });
  // @ts-expect-error MQTT reserves the QoS 3 flag pattern.
  createTcpClient({ ...options, will: { topic: 'status', payload: 'offline', qos: 3 } });
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
export async function checkTcpDeclarations(signal: AbortSignal) {
  const observer: DiagnosticObserver = (event: ClientDiagnostic) => {
    if (event.kind === 'connection') event.state.toUpperCase();
  };
  const tcp = createTcpClient({
    onDiagnostic: observer,
    host: '127.0.0.1',
    maxPacketBytes: 4096,
    clientId: 'consumer',
    maxPendingSubscriptions: 4,
    maxPendingSubscriptionBytes: 4096,
    signal,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onMessage(packet) {
      const payload: Buffer = packet.payload;
      payload[0] = packet.qos;
    },
  });
  const connected = await tcp.connect();
  await connected.subscribe('consumer/qos1', { qos: 1 });
  await connected.publish('consumer/qos1', 'hello', { qos: 1, signal });
  await connected.publish('consumer/qos2', 'hello', { qos: 2, signal });
  // @ts-expect-error MQTT has no QoS 3.
  await connected.publish('consumer/qos3', 'hello', { qos: 3 });
  const granted: 0 | 1 | 2 = (await connected.subscribe('consumer/qos2', { qos: 2 })).grantedQos;
  await connected.ping();
  await connected.disconnect();
  return granted;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
export async function checkWebSocketDeclarations(signal: AbortSignal) {
  const factory = createWebSocketClient({
    url: new URL('wss://localhost/mqtt'),
    clientId: 'consumer',
    maxPendingSubscriptions: 4,
    maxPendingSubscriptionBytes: 4096,
    maxWebSocketMessageBytes: 4096,
    maxPacketBytes: 4096,
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
import { createBrowserClient } from 'mqtt/browser';

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
export async function checkBrowserClientDeclarations(signal: AbortSignal) {
  const client = await createBrowserClient({
    url: 'wss://localhost/mqtt',
    clientId: 'consumer',
    maxPendingSubscriptions: 4,
    maxPendingSubscriptionBytes: 4096,
    maxWebSocketMessageBytes: 4096,
    signal,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onMessage(message) {
      const bytes: Uint8Array = message.payload;
      bytes.byteLength.toFixed();
    },
  }).connect();
  await client.subscribe('a', { qos: 1 });
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

export const secureTcpConsumer = createTcpClient({
  host: 'broker.example',
  clientId: 'packed-tls',
  tls: { servername: 'broker.example' } satisfies import('mqtt').TcpTlsOptions,
});

import { isMqttError, type MqttErrorCode } from 'mqtt';
export type MqttErrorCodeIsClosed = RequireFalse<string extends MqttErrorCode ? true : false>;

export function retryAfterCapacity(error: unknown): boolean {
  return isMqttError(error, 'ERR_MQTT_CAPACITY') && !error.fatal;
}
