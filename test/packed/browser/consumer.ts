import { createBrowserClient, createReconnectingClient, watchPageLifecycle } from 'mqtt/browser';
import { PacketDecoder, type WirePacket } from 'mqtt/codec';
import { createTransportClient, type ByteTransport } from 'mqtt/portable';
import type { WebSocketOptions } from 'mqtt/websocket';
import type {
  BrowserClientOptions,
  BrowserQosOneMessage,
  BrowserSession,
  ClientDiagnostic,
  ClientFactory,
  DiagnosticObserver,
  DisconnectOptions,
  ClientSession,
  PageLifecycleOptions,
  PageReturn,
  ConnectionInfo,
  PublishOptions,
  QosOneMessage,
  SessionEnd,
  SessionEndObserver,
  SubscribeOptions,
  SubscribeResult,
  UnsubscribeResult,
  WillOptions,
} from 'mqtt/browser';

type RequireTrue<Value extends true> = Value;
type RequireFalse<Value extends false> = Value;
type IsAny<Value> = 0 extends 1 & Value ? true : false;
export type BrowserHasNoNodeGlobals = RequireTrue<
  Extract<'Buffer' | 'process', keyof typeof globalThis> extends never ? true : false
>;
type Received = Parameters<NonNullable<BrowserClientOptions['onMessage']>>[0];
export type PackedPayloadIsSpecific = RequireFalse<IsAny<Received['payload']>>;
export type PackedPayloadIsBytes = RequireTrue<Received['payload'] extends Uint8Array ? true : false>;
type ReceivedQosOne = Parameters<NonNullable<BrowserClientOptions['onQosOneMessage']>>[0];
export type PackedQosOnePayloadIsSpecific = RequireFalse<IsAny<ReceivedQosOne['payload']>>;
export type PackedBrowserMessageNamesItsProperties = RequireTrue<
  Received extends import('mqtt/browser').MessageProperties ? true : false
>;
export type PackedQosOneMessage = RequireTrue<ReceivedQosOne extends QosOneMessage<Received> ? true : false>;
export type BrowserQosOneCallbackUsesNamedMessage = RequireTrue<ReceivedQosOne extends BrowserQosOneMessage ? true : false>;
export type NamedBrowserQosOneMatchesCallback = RequireTrue<BrowserQosOneMessage extends ReceivedQosOne ? true : false>;
export type PackedQosIsZero = RequireTrue<Received['qos'] extends 0 ? true : false>;
export type PackedSessionIsCommon = RequireTrue<BrowserSession extends ClientSession ? true : false>;
export type BrowserOwnsTls = RequireTrue<
  Extract<'ca' | 'cert' | 'key' | 'agent', keyof BrowserClientOptions> extends never ? true : false
>;

const observer: DiagnosticObserver = (event: ClientDiagnostic) => {
  if (event.kind === 'packet') event.command.toUpperCase();
};

type EndNotice = Parameters<NonNullable<BrowserClientOptions['onSessionEnd']>>[0];
export type BrowserEndNoticeIsSpecific = RequireFalse<IsAny<EndNotice>>;
export type BrowserEndNoticeUsesNamedType = RequireTrue<SessionEnd extends EndNotice ? true : false>;
const onSessionEnd: SessionEndObserver = (event) => {
  if (event.kind === 'error') event.error.message.toUpperCase();
};

const options: BrowserClientOptions = {
  onSessionEnd,
  onDiagnostic: observer,
  url: 'wss://localhost/mqtt',
  clientId: 'packed-browser-types',
  maxWebSocketMessageBytes: 4096,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The consumer verifies the original mutable Uint8Array callback contract.
  onMessage(message) {
    const bytes: Uint8Array = message.payload;
    bytes[0] = message.qos;
  },
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Check the mutable callback bytes without Node types.
  async onQosOneMessage(message) {
    const bytes: Uint8Array = message.payload;
    bytes[0] = message.qos;
    await Promise.resolve();
  },
};
export const factory: ClientFactory = createBrowserClient(options);

export async function checkPublishOptions(client: Readonly<ClientSession>) {
  const publish: PublishOptions = { qos: 1, signal: AbortSignal.timeout(1000) };
  const subscription: SubscribeOptions = { qos: 1 };
  await client.subscribe('packed/qos1', subscription);
  await client.publish('packed/qos1', 'payload', publish);
}

export async function checkDisconnect(client: Readonly<ClientSession>) {
  const options: DisconnectOptions = { drain: false };
  await client.disconnect(options);
}

export async function checkBrowserResults(client: Readonly<ClientSession>) {
  const connection: ConnectionInfo = client.connection;
  // @ts-expect-error The negotiated client identifier is read-only.
  connection.clientId = 'different';
  const subscribed: SubscribeResult = await client.subscribe('sensor/status');
  const unsubscribed: UnsubscribeResult = await client.unsubscribe('sensor/status');
  return { clientId: connection.clientId, grantedQos: subscribed.grantedQos, reason: unsubscribed.reasonCode };
}

export function checkDecoderCompletion() {
  const decoder = new PacketDecoder();
  decoder.push(Uint8Array.of(0xd0, 0));
  decoder.finish();
}

export function checkBrowserWillOptions(): ClientFactory {
  const will: WillOptions = { topic: 'sensor/status', payload: Uint8Array.of(1), qos: 2 };
  const options = { url: 'ws://localhost/mqtt', clientId: 'browser-will' };
  // @ts-expect-error A Byte view is required for binary Correlation Data.
  createBrowserClient({ ...options, will: { ...will, correlationData: 'token' } });
  return createBrowserClient({ ...options, will });
}

export function checkNativeWebSocketOptions(): WebSocketOptions {
  const socketOptions: WebSocketOptions = { signal: AbortSignal.timeout(1000), timeoutMs: 500 };
  return socketOptions;
}

type TransportPayload = Parameters<NonNullable<Parameters<typeof createTransportClient>[1]['onMessage']>>[0]['payload'];
export type TransportPayloadIsSpecific = RequireFalse<IsAny<TransportPayload>>;
export type TransportPayloadIsBytes = RequireTrue<TransportPayload extends Uint8Array ? true : false>;
export function createCustomBrowserFactory(transport: Readonly<ByteTransport>): ClientFactory {
  return createTransportClient(transport, { clientId: 'packed-browser-custom' });
}

export function checkDecoderBatch() {
  const decoder = new PacketDecoder();
  const batch = decoder.pushBatch(Uint8Array.of(0xd0, 0, 0x90, 3, 0, 1, 0));
  const packets: WirePacket[] = Array.isArray(batch) ? batch : batch.packets;
  return { packets, error: Array.isArray(batch) ? undefined : batch.error };
}

export function checkPageLifecycle(): () => void {
  const client = createReconnectingClient(createBrowserClient, { url: 'wss://localhost/mqtt', clientId: 'packed-lifecycle' });
  const retried: boolean = client.retryNow();
  const lifecycle: PageLifecycleOptions = {
    onReturn(event: PageReturn) {
      const outcome: 'retried' | 'answered' | 'ended' | 'stopped' | 'skipped' = event.outcome;
      outcome.toUpperCase();
      event.awayMs.toFixed(retried ? 1 : 0);
    },
  };
  return watchPageLifecycle(client, lifecycle);
}
