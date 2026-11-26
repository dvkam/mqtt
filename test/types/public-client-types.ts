import { createTcpClient } from '../../dist/index.js';
import { createWebSocketClient, type WebSocketClientOptions } from '../../dist/ws.js';
import type {
  ClientFactory,
  ClientSession,
  MessageProperties,
  PublishProperties,
  NodeMessage,
  NodeQosOneMessage,
  TcpClientOptions,
  UserProperty,
} from '../../dist/index.js';

type RequireTrue<Value extends true> = Value;
type RequireFalse<Value extends false> = Value;
type IsAny<Value> = 0 extends 1 & Value ? true : false;
type CallbackMessage = Parameters<NonNullable<TcpClientOptions['onMessage']>>[0];

export type PayloadIsSpecific = RequireFalse<IsAny<CallbackMessage['payload']>>;
export type PayloadIsBuffer = RequireTrue<CallbackMessage['payload'] extends Buffer ? true : false>;
export type MessageIsQosZero = RequireTrue<CallbackMessage['qos'] extends 0 ? true : false>;
export type NodeMessageHasBuffer = RequireTrue<NodeMessage['payload'] extends Buffer ? true : false>;
export type NodeMessageIsFlat = RequireFalse<'properties' extends keyof NodeMessage ? true : false>;
export type NodeMessageHasNoLength = RequireFalse<'length' extends keyof NodeMessage ? true : false>;
export type NodeMessageNamesItsProperties = RequireTrue<NodeMessage extends MessageProperties ? true : false>;
export type NodeCorrelationDataIsBuffer = RequireTrue<NonNullable<NodeMessage['correlationData']> extends Buffer ? true : false>;
export type NodeUserPropertiesAreOrderedPairs = RequireTrue<
  NonNullable<NodeMessage['userProperties']> extends readonly UserProperty[] ? true : false
>;
export type CallbackUserPropertyIsStringPair = RequireTrue<
  NonNullable<CallbackMessage['userProperties']>[number] extends readonly [string, string] ? true : false
>;
export type NodeSubscriptionIdentifiersAreAList = RequireTrue<
  NonNullable<NodeMessage['subscriptionIdentifiers']> extends readonly number[] ? true : false
>;
export type NodePayloadFormatIsNumeric = RequireTrue<
  NonNullable<NodeMessage['payloadFormatIndicator']> extends 0 | 1 ? true : false
>;
export type NodeQosOneKeepsProperties = RequireTrue<NodeQosOneMessage extends MessageProperties ? true : false>;
export type NodeContentTypeIsOptionalText = RequireTrue<CallbackMessage['contentType'] extends string | undefined ? true : false>;
export type PortRejectsText = RequireFalse<string extends NonNullable<TcpClientOptions['port']> ? true : false>;
export type SessionIsNamed = RequireTrue<Awaited<ReturnType<ClientFactory['connect']>> extends ClientSession ? true : false>;

const tcpOptions: TcpClientOptions = {
  host: '127.0.0.1',
  clientId: 'named-tcp-types',
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The callback contract preserves the original mutable Node Buffer.
  onMessage(message) {
    const payload: Buffer = message.payload;
    const qualityOfService: 0 = message.qos;
    payload[0] = qualityOfService;
  },
};
const websocketOptions: WebSocketClientOptions = {
  url: 'wss://localhost/mqtt',
  clientId: 'named-ws-types',
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The callback contract preserves the original mutable Node Buffer.
  onMessage(message) {
    message.payload.subarray(0, 1).fill(0);
  },
};

export const tcpFactory: ClientFactory = createTcpClient(tcpOptions);
export const websocketFactory: ClientFactory = createWebSocketClient(websocketOptions);

type NodePassword = NonNullable<TcpClientOptions['password']>;
export type NodePasswordAcceptsText = RequireTrue<string extends NodePassword ? true : false>;
export type NodePasswordAcceptsBytes = RequireTrue<
  Buffer extends NodePassword ? (Uint8Array extends NodePassword ? true : false) : false
>;
export type NodePasswordRejectsNumbers = RequireFalse<number extends NodePassword ? true : false>;
export type WebSocketPasswordMatchesTcp = RequireTrue<
  NonNullable<WebSocketClientOptions['password']> extends NodePassword
    ? NodePassword extends NonNullable<WebSocketClientOptions['password']>
      ? true
      : false
    : false
>;
export const textPasswordTcp = createTcpClient({
  host: 'broker.example',
  clientId: 'text-password',
  username: 'u',
  password: 'secret',
});
export const bytePasswordTcp = createTcpClient({
  host: 'broker.example',
  clientId: 'byte-password',
  password: Buffer.from('secret'),
});

type Publish = ClientSession['publish'];
export type PublishAcceptsTextAndBytes = RequireTrue<
  string extends Parameters<Publish>[1] ? (Uint8Array extends Parameters<Publish>[1] ? true : false) : false
>;
export type PublishRejectsNumbers = RequireFalse<number extends Parameters<Publish>[1] ? true : false>;
export type PublishOptionsCarryProperties = RequireTrue<
  NonNullable<Parameters<Publish>[2]> extends Readonly<PublishProperties> ? true : false
>;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture passes a native AbortSignal and Buffer payload as ClientSession.publish declares them.
export async function publishWithProperties(session: ClientSession, signal: AbortSignal): Promise<void> {
  await session.publish('bytes', Buffer.from([1, 2]), { signal });
  await session.publish('reply', 'text', {
    qos: 1,
    retain: true,
    payloadFormatIndicator: 1,
    messageExpiryInterval: 60,
    contentType: 'text/plain',
    responseTopic: 'reply/7',
    correlationData: Uint8Array.of(7),
    userProperties: [['k', 'v']],
    signal,
  });
}
