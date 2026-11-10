import { createBrowserClient, openBrowserTransport } from 'mqtt/browser';
import { PacketDecoder, type WirePacket } from 'mqtt/codec';
import { openMqttWebSocket, type WebSocketOptions } from 'mqtt/websocket';
import type {
  BrowserClientOptions,
  BrowserCloseKind,
  BrowserQosOneMessage,
  BrowserSession,
  BrowserTransportOptions,
  ClientDiagnostic,
  ClientFactory,
  DiagnosticObserver,
  ClientSession,
  PublishOptions,
  QosOneMessage,
  SessionEnd,
  SessionEndObserver,
  SubscribeOptions,
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

export async function checkTransportCloseKind() {
  const transportOptions: BrowserTransportOptions = {
    maxWebSocketMessageBytes: 4096,
    onBytes() {},
    onClose(_reason: Readonly<Error>, kind) {
      const closeKind: BrowserCloseKind = kind;
      if (closeKind === 'remote') return;
    },
  };
  return openBrowserTransport('wss://localhost/mqtt', transportOptions);
}

export function checkDecoderCompletion() {
  const decoder = new PacketDecoder();
  decoder.push(Uint8Array.of(0xd0, 0));
  decoder.finish();
}

export async function checkNativeWebSocketOptions() {
  const socketOptions: WebSocketOptions = { signal: AbortSignal.timeout(1000), timeoutMs: 500 };
  return openMqttWebSocket('wss://localhost/mqtt', socketOptions);
}

export function checkDecoderBatch() {
  const decoder = new PacketDecoder();
  const batch = decoder.pushBatch(Uint8Array.of(0xd0, 0, 0x90, 3, 0, 1, 0));
  const packets: WirePacket[] = Array.isArray(batch) ? batch : batch.packets;
  return { packets, error: Array.isArray(batch) ? undefined : batch.error };
}
