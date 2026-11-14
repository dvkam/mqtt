import { createTcpClient, createWebSocketClient } from '../../dist/index.js';
import type {
  ClientFactory,
  ClientSession,
  MessageProperties,
  NodeMessage,
  NodeQosOneMessage,
  TcpClientOptions,
  UserProperty,
  WebSocketClientOptions,
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
export type NodeSubscriptionIdentifiersAreAList = RequireTrue<
  NonNullable<NodeMessage['subscriptionIdentifiers']> extends readonly number[] ? true : false
>;
export type NodePayloadFormatIsNumeric = RequireTrue<
  NonNullable<NodeMessage['payloadFormatIndicator']> extends 0 | 1 ? true : false
>;
export type NodeQosOneKeepsProperties = RequireTrue<NodeQosOneMessage extends MessageProperties ? true : false>;
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
    const contentType: string | undefined = message.contentType;
    const [key, value]: readonly [string, string] = message.userProperties?.[0] ?? ['', ''];
    void [contentType, key, value];
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
