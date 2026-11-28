import { createReconnectingClient, createSessionState, createTcpClient, type ReconnectEvent } from '../../dist/index.js';
import { createWebSocketClient, type WebSocketClientOptions } from '../../dist/ws.js';
import type {
  ClientFactory,
  ClientSession,
  MessageProperties,
  PublishProperties,
  NodeMessage,
  NodeQosOneMessage,
  SessionEnd,
  SessionState,
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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The handler assigns the payload to a `Buffer` constant and the QoS to `0` to pin the types the TCP client delivers. A parameter type written here would replace the delivered type, and the assignments would check nothing.
  onMessage(message) {
    const payload: Buffer = message.payload;
    const qualityOfService: 0 = message.qos;
    payload[0] = qualityOfService;
  },
};
const websocketOptions: WebSocketClientOptions = {
  url: 'wss://localhost/mqtt',
  clientId: 'named-ws-types',
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The handler fills the delivered payload on purpose, to check that the published types keep the consumer's bytes writable. A read-only parameter type would be false and would remove that check.
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

export async function publishWithProperties(session: Readonly<ClientSession>, signal: Readonly<AbortSignal>): Promise<void> {
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

export const reconnectingTcp = createReconnectingClient(
  createTcpClient,
  { host: 'localhost', clientId: 'reconnecting' },
  { subscriptions: [{ topic: 'sensor/+', qos: 0 }], maxAttempts: 5 },
);
export const reconnectingWebSocket = createReconnectingClient(createWebSocketClient, {
  url: 'ws://localhost:8080',
  clientId: 'reconnecting',
});
export type ReconnectSessionIsClientSession = RequireTrue<
  Awaited<ReturnType<typeof reconnectingTcp.session>> extends ClientSession ? true : false
>;
export type ConnectedEventNamesThePreviousEnd = RequireTrue<
  Extract<ReconnectEvent, { kind: 'connected' }>['previous'] extends SessionEnd | undefined ? true : false
>;

export const resumingTcp = createReconnectingClient(
  createTcpClient,
  { host: 'localhost', clientId: 'resuming', sessionExpiryInterval: 3600 },
  { subscriptions: [{ topic: 'sensor/+', qos: 0 }], resume: true },
);
export const resumedTcp = createTcpClient({
  host: 'localhost',
  clientId: 'resumed',
  cleanStart: false,
  sessionExpiryInterval: 3600,
  sessionState: createSessionState(),
});
export type SessionStateIsBranded = RequireFalse<
  { readonly inFlight: readonly { topic: string; messageId: number; acknowledged: boolean }[] } extends SessionState ? true : false
>;
export type SessionStateListsUncertainPublications = RequireTrue<
  SessionState['inFlight'] extends readonly { readonly topic: string; readonly messageId: number }[] ? true : false
>;
export type ConnectedEventReportsResumption = RequireTrue<
  Extract<ReconnectEvent, { kind: 'connected' }>['resumed'] extends boolean ? true : false
>;
export type PubackEventCarriesTheReasonCode = RequireTrue<
  Extract<ReconnectEvent, { kind: 'puback' }>['reasonCode'] extends number ? true : false
>;
