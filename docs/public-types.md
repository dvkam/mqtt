# Public client types

Use `import type` for the named contracts. TypeScript 7.0.2 is the supported compiler floor for the preview. The repository builds with 7.1.0-beta. The packed CI job checks the installed Node and DOM-only browser consumers with both versions.

| Type                                                                              | Entry point                             | Contract                                                                                                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `TcpClientOptions`                                                                | `mqtt`                                  | Host, optional port, session options and cancellation signal                                                                                 |
| `WebSocketClientOptions`                                                          | `mqtt/ws`                               | URL, TLS and agent options, session options and local write budget                                                                           |
| `NodeMessage`, `NodeQosOneMessage`, `NodeQosTwoMessage` | `mqtt` | Received QoS 0, 1 and 2 PUBLISH as a flat object with a mutable Buffer payload |
| `BrowserClientOptions`                                                            | `mqtt/browser`                          | URL, session options, cancellation and independent byte and packet budgets                                                                   |
| `BrowserMessage`, `BrowserQosOneMessage`, `BrowserQosTwoMessage` | `mqtt/browser` | Received QoS 0, 1 and 2 PUBLISH as a flat object with a mutable Uint8Array payload |
| `QosOneMessage`, `QosTwoMessage` | Both client entries and `mqtt/portable` | A received message type with `qos` 1 or 2, a `messageId` and a `dup` flag |
| `ClientDiagnostic`, `DiagnosticObserver`                                          | Both client entries and `mqtt/portable` | Optional packet command and connection state metadata                                                                                        |
| `SessionEnd`, `SessionEndObserver`, `UncertainPublication` | Both client entries and `mqtt/portable` | First logical retirement, the QoS 1 and QoS 2 publications in flight at that point with their `qos` and `acknowledged` flag, and its optional observer |
| `createReconnectingClient`, `ReconnectOptions`, `ReconnectEvent`, `ReconnectingClient`, `Reconnectable`, `SubscriptionIntent`, `SubscriptionRestore` | Both client entries and `mqtt/portable` | A client that opens a new session after each failure. See [reconnecting](reconnect.md). |
| `watchPageLifecycle`, `PageLifecycleOptions`, `PageReturn` | `mqtt/browser` | Checks a reconnecting client each time the page comes back. See [page lifecycle](page-lifecycle.md). |
| `ClientFactory`                                                                   | Both client entries                     | One cached connection attempt through `connect()`                                                                                            |
| `ClientSession`                                                                   | Both client entries                     | Subscribe, unsubscribe, text and byte publish, ping and disconnect promises |
| `BrowserSession`                                                                  | `mqtt/browser`                          | Alias for `ClientSession`                                                                                                                    |
| `PublishOptions`, `PublishProperties`, `SubscribeOptions` | Both client entries and `mqtt/portable` | QoS, cancellation, retain and the MQTT 5 PUBLISH properties. See [publishing](publishing.md). |
| `DisconnectOptions` | `mqtt`, `mqtt/browser`, `mqtt/portable` | QoS 1 and QoS 2 drain, drain timeout, and normal or Will disconnection reason |
| `WillOptions` | `mqtt`, `mqtt/ws`, `mqtt/browser`, `mqtt/portable` | Will topic, string or byte payload, QoS 0, 1, or 2, retain, and Will properties |
| `ConnectionInfo`, `SubscribeResult`, `UnsubscribeResult` | `mqtt`, `mqtt/ws`, `mqtt/browser`, `mqtt/portable` | Negotiated connection snapshot and successful subscription outcomes |
| `SessionOptions`, `SessionState`, `createSessionState` | Both client entries and `mqtt/portable` | Clean Start, Session Expiry Interval and the state, held in memory, that keeps unfinished QoS 1 and QoS 2 exchanges for the next connection. Only `createSessionState` makes a `SessionState`. See [resuming the session](reconnect.md#resuming-the-session). |
| `WebSocketOptions`                                                                | `mqtt/websocket`                        | Type for native WebSocket timeout and cancellation options                                                                                 |
| `ByteClientOptions`, `ByteTransport`, `ByteInbound`, `ByteWriter`, `OpenContext` | `mqtt`, `mqtt/portable` | Session options and the [custom transport contract](#custom-transport-contract) |
| `MqttError`, `isMqttError`, `MqttErrorCode`, `MqttErrorDetails` | `mqtt`, `mqtt/browser`, `mqtt/portable` | Session rejection with a stable `code`, a `fatal` flag and the MQTT `reasonCode`. See [error codes](errors.md). |
| `ProtocolInputError`, `ProtocolInputCode`                                         | `mqtt/portable`                         | Decoder rejection. An `MqttError` with code `ERR_MQTT_PROTOCOL` and `reasonCode` 0x81, 0x82 or 0x94 |

`onMessage` handles QoS 0. Register `onQosOneMessage` before requesting a QoS 1 subscription. Its message adds a packet identifier and a DUP flag, with the same platform-specific payload type. The client acknowledges the delivery after that handler succeeds. See [inbound QoS 1 delivery](qos1-receive.md). A QoS 2 subscription needs `onQosTwoMessage` and `onQosOneMessage`. The client calls `onQosTwoMessage` for each QoS 2 publication and sends PUBREC after the handler succeeds. A duplicate PUBLISH of the same exchange calls it again only when the earlier call failed. See [QoS 2](qos2.md#receive-at-qos-2).

Node and browser factories share a session interface. Repeated `connect()` calls return the same promise. Browser declarations compile using DOM libraries with no Node ambient types. Factory options hold the requested client identifier. `session.connection.clientId` exposes the identifier accepted for that connection. `createReconnectingClient` builds a new factory for each attempt, so this promise identity holds for each factory. A one-shot factory resumes a session when it gets `cleanStart: false` and the `SessionState` an earlier factory used. A session state that survives a process restart remains under #14, and identity continuity under #19.

## Broker acknowledgment results

`session.connection` is the frozen snapshot of the successful CONNACK. It contains the assigned client identifier when CONNECT requested an empty one. A missing Receive Maximum defaults to 65,535, Maximum QoS defaults to 2, and Topic Alias Maximum and Server Keep Alive default to 0. The broker capability flags default to true when absent. `sessionPresent` is the CONNACK flag, true only after `cleanStart: false`. `sessionExpiryInterval` is the broker's CONNACK value, or else the value CONNECT sent, or else 0. Maximum Packet Size, Response Information, Server Reference, and User Properties remain optional. The client rejects a PUBLISH, SUBSCRIBE or UNSUBSCRIBE larger than Maximum Packet Size with `ERR_MQTT_CAPACITY` before it writes the packet. [Outgoing admission](outgoing-admission.md#maximum-packet-size) The object's User Property tuples and array are also frozen. These are broker capabilities. The preview still has its own supported operations. [Codec profile](codec.md#supported-profile)

`subscribe()` returns the granted QoS and reason code, with Reason String and ordered User Properties when supplied. The broker can grant less than the request, so a QoS 2 request can succeed with `grantedQos` 0, 1 or 2. `unsubscribe()` returns reason `0` for success or `17` for no subscription, with an optional Reason String. Both results wait for the matching broker acknowledgment and native write settlement. A refusal rejects with `ERR_MQTT_REFUSED` and carries the broker's numeric `reasonCode`. [Error codes](errors.md)

The Promise types change from `Promise<void>` to `Promise<SubscribeResult>` and `Promise<UnsubscribeResult>`. Calls that await and ignore the result keep working. A callback that requires `Promise<void>` can await the operation without returning its value. Code that constructs a `ClientSession` test double supplies `connection` and the result objects.

## Received message fields

`onMessage`, `onQosOneMessage` and `onQosTwoMessage` receive one flat object on every platform. The Node and browser messages differ only in their byte types.

| Field                     | Type                                          | Notes                                                 |
| ------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| `cmd`                     | `'publish'`                                   |                                                       |
| `topic`                   | `string`                                      |                                                       |
| `payload`                 | `Buffer` on Node, `Uint8Array` in the browser |                                                       |
| `qos` | `0`, `1` in `onQosOneMessage`, or `2` in `onQosTwoMessage` | |
| `dup` | `false`, or `boolean` in `onQosOneMessage` and `onQosTwoMessage` | |
| `retain`                  | `boolean`                                     |                                                       |
| `messageId` | `number` | Only in `onQosOneMessage` and `onQosTwoMessage` |
| `payloadFormatIndicator`  | `0` or `1`                                    |                                                       |
| `messageExpiryInterval`   | `number`                                      | Seconds                                               |
| `contentType`             | `string`                                      |                                                       |
| `responseTopic`           | `string`                                      |                                                       |
| `correlationData`         | `Buffer` on Node, `Uint8Array` in the browser |                                                       |
| `subscriptionIdentifiers` | `readonly number[]`                           | Wire order                                            |
| `userProperties`          | `readonly UserProperty[]`                     | `[key, value]` pairs in wire order. A key can repeat. |

The last seven fields are the PUBLISH properties, and `MessageProperties` names them. Its type parameter is the byte type. `NodeMessage` and `BrowserMessage` are the same received-message type with `Buffer` and `Uint8Array` bytes, so the two platforms cannot drift apart. A property the broker left out is an absent key. Both client entries export `MessageProperties` and `UserProperty`.

On Node, `payload` and `correlationData` are views of the one allocation the decoder made for the packet. Keeping either one keeps the whole packet in memory. Copy the bytes with `Buffer.from(message.payload)` to keep a payload for a long time.

The client does not check a received payload as UTF-8 when `payloadFormatIndicator` is 1. MQTT 5 section 3.3.2.3.2 makes that check optional for a receiver.

### Change from the mqtt-packet shape

`NodeMessage` used to be mqtt-packet's `IPublishPacket` with a Buffer payload. It now matches `BrowserMessage`. `BrowserMessage` gained the six properties other than `userProperties`, which it dropped before.

| Before                                                                       | After                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `message.properties?.contentType`                                            | `message.contentType`                                  |
| `message.properties?.responseTopic`                                          | `message.responseTopic`                                |
| `message.properties?.messageExpiryInterval`                                  | `message.messageExpiryInterval`                        |
| `message.properties?.correlationData`                                        | `message.correlationData`                              |
| `message.properties?.payloadFormatIndicator`, a `boolean`                    | `message.payloadFormatIndicator`, `0` or `1`           |
| `message.properties?.subscriptionIdentifier`, a `number` or `number[]`       | `message.subscriptionIdentifiers`, always a list       |
| `message.properties?.userProperties`, a map of `string` or `string[]` values | `message.userProperties`, ordered `[key, value]` pairs |
| `message.length`                                                             | Removed                                                |
| `message.messageId` and `message.properties?.topicAlias` on a QoS 0 message | Removed. Neither was ever set |
| `message.dup`, a `boolean` | `false` on a QoS 0 message, `boolean` on a QoS 1 or QoS 2 message |

The old map kept the order of values under one key but lost the order between keys. The pairs keep the order the broker sent, which MQTT 5 requires a forwarder to keep (MQTT-3.3.2-18).

## Custom transport contract

Call `createTransportClient(transport, options).connect()`. Import it from `mqtt` for Buffer messages or from `mqtt/portable` for Uint8Array messages and a browser bundle. Both entries export the transport types. The factory caches one connection attempt. Create a new factory to retry.

- `ByteTransport.open(inbound, context)` opens one connection. Install readers before returning its writer. If `context.signal` aborts during the open, release the connection and reject. Apply `context.timeoutMs` to the open. `context.maxPacketBytes` is the validated MQTT packet limit, which an adapter can use to size its own receive limit.
- Pass received bytes to `inbound.bytes(chunk)` at any chunk boundary. Pass a peer end to `inbound.end()` and a transport error to `inbound.fail(error)`. The core copies the bytes it keeps and owns framing, decoding, and MQTT validation.
- Return a `ByteWriter` whose `bufferedBytes` reports accepted bytes that have yet to flush. Use `frameOverhead(length)` when the transport adds bytes per write. Hand each chunk to the transport in call order and settle `write` when the transport takes it.
- `close(false)` closes gracefully. `close(true)` releases the transport promptly, settles pending writes, and makes later writes reject. Close must accept repeated calls. Each transport owns its close deadline and any limits on its own messages, including WebSocket messages.
- Set `supportsSharedSubscriptions` or `supportsPassword` to `false` if the transport cannot support that option. Both default to `true`. The built-in browser client disables shared subscriptions.

See [Using a custom transport](recipes/using-custom-transports.md) for a Node `Duplex` example and [Byte transport and transport core](byte-transport.md) for lifecycle details.

## Migrate removed transport hooks

| Previous API | Replacement |
| --- | --- |
| `connectPortable` and `PortableOptions` from `mqtt/portable` | Call `createTransportClient(transport, options).connect()`. Use `ByteClientOptions<Buffer>` in Node or `ByteClientOptions` for `Uint8Array` callbacks. |
| `PacketTransport` from `mqtt/portable` | Implement `ByteTransport`. Pass bytes, end, and error events through `ByteInbound`. Move packet encoding, decoding, and validation out of the adapter. |
| `openBrowserTransport`, `BrowserTransport`, `BrowserTransportOptions`, `BrowserCloseKind`, and `WriteTraffic` from `mqtt/browser` | Use `createBrowserClient` for a standard MQTT WebSocket session or implement `ByteTransport` for your own connection. |
| `openMqttWebSocket` from `mqtt/websocket` | Use `createBrowserClient` for a session on a native WebSocket. For raw frames, open a native `WebSocket` with the `mqtt` subprotocol and set `binaryType` to `arraybuffer`. `mqtt/websocket` still exports the `WebSocketOptions` type. |

`mqtt/portable` still exports the packet types and `ProtocolInputError` for code that works with the codec directly.

## Packed verification

Build and pack the package. Install the tarball and the pinned Node types into a clean ESM consumer. Run `test/packed/tcp-only-check.mjs` there before anything else, because it needs a consumer without `ws`. Then install `ws` at the version in `devDependencies`: the Node fixtures import `mqtt/ws`. Copy the Node fixture and its tsconfig from `test/packed`. The packed browser launcher copies the DOM-only fixture and uses the locked `typescript-stable` alias to check both projects. The normal build, Node packed step and browser launcher use the 7.1 beta compiler. The fixtures check contextual callbacks, mutable platform payloads, QoS discriminants and invalid publish options. The browser tsconfig uses an empty `types` list.

Run Publint 0.3.25 and Are the Types Wrong 0.18.5 against the tarball. Use the latter's `esm-only` profile for the package's ESM and bundler resolution modes. The profile excludes Node 10 and CommonJS resolution modes.

Refs #50.

## Session end

Set `onSessionEnd` on a TCP, Node WebSocket, browser or custom transport client to observe its first MQTT retirement. The observer runs after pending protocol work has been retired. It can run during MQTT connection setup if the transport has already reached the portable session. Use the `connect()` rejection for failures before that point.

- `{ kind: 'disconnect' }` means the local MQTT DISCONNECT write completed and won the retirement race. An application queue can drain its admitted messages. The native socket may still be closing, so await `disconnect()` for that result.
- `{ kind: 'error', error }` carries the original Error used to retire protocol work. A broker DISCONNECT, transport close, cancellation and protocol failure can all produce this outcome. Treat the error as application data. Use `onDiagnostic` for redacted command and state metadata. After a broker DISCONNECT the client sends no DISCONNECT in reply and force-closes the transport.

The callback is queued once. Its return value never delays socket closure or protocol settlement, and thrown or rejected callbacks leave the first outcome intact. Application cancellation of a message consumer is separate from cancellation of its session.

`TcpTlsOptions` names the native CA, client certificate, key and servername settings accepted by `TcpClientOptions.tls`. See the [TCP TLS guide](tcp-tls.md).
