# Public client types

Use `import type` for the named contracts. TypeScript 7.0.2 is the supported compiler floor for the preview. The repository builds with 7.1.0-beta. The packed CI job checks the installed Node and DOM-only browser consumers with both versions.

| Type                                                                              | Entry point                             | Contract                                                                                                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `TcpClientOptions`                                                                | `mqtt`                                  | Host, optional port, session options and cancellation signal                                                                                 |
| `WebSocketClientOptions`                                                          | `mqtt`                                  | URL, TLS and agent options, session options and local write budget                                                                           |
| `NodeMessage`, `NodeQosOneMessage`                                                | `mqtt`                                  | Received QoS 0 and 1 PUBLISH with a mutable Buffer payload                                                                                   |
| `BrowserClientOptions`                                                            | `mqtt/browser`                          | URL, session options, cancellation and independent byte and packet budgets                                                                   |
| `BrowserMessage`, `BrowserQosOneMessage`                                          | `mqtt/browser`                          | Received QoS 0 and 1 PUBLISH with a mutable Uint8Array payload                                                                               |
| `ClientDiagnostic`, `DiagnosticObserver`                                          | Both client entries and `mqtt/portable` | Optional packet command and connection state metadata                                                                                        |
| `SessionEnd`, `SessionEndObserver`                                                | Both client entries and `mqtt/portable` | First logical retirement and its optional observer                                                                                           |
| `ClientFactory`                                                                   | Both client entries                     | One cached connection attempt through `connect()`                                                                                            |
| `ClientSession`                                                                   | Both client entries                     | Subscribe, unsubscribe, text publish, ping and disconnect promises                                                                           |
| `BrowserSession`                                                                  | `mqtt/browser`                          | Alias for `ClientSession`                                                                                                                    |
| `PublishOptions`, `SubscribeOptions`                                              | Both client entries                     | QoS options. Only QoS 1 publish accepts a cancellation signal.                                                                               |
| `BrowserTransportOptions`, `BrowserTransport`, `BrowserCloseKind`, `WriteTraffic` | `mqtt/browser`                          | Native browser transport callbacks, send and close operations, and their argument types                                                      |
| `WebSocketOptions`                                                                | `mqtt/websocket`                        | Timeout and cancellation for opening a native MQTT WebSocket                                                                                 |
| `PortableOptions`, `PacketTransport`                                              | `mqtt/portable`                         | Experimental generic client and custom transport options. The packet contract uses mqtt-packet declarations.                                 |
| `ProtocolInputError`, `ProtocolInputCode`                                         | `mqtt/portable`                         | Decoder rejection passed to the optional transport protocol-error callback. Its readonly code is 0x81, 0x82 or 0x94. These are type exports. |

`onMessage` handles QoS 0. Register `onQosOneMessage` before requesting a QoS 1 subscription. Its message adds a packet identifier and a DUP flag, with the same platform-specific payload type. The client acknowledges the delivery after that handler succeeds. See [inbound QoS 1 delivery](qos1-receive.md).

Node and browser factories share a session interface. Their repeated `connect()` calls return the same promise. Browser declarations compile using DOM libraries with no Node ambient types. Legacy options have their own [compatibility notes](legacy-options.md). The requested client identifier belongs to factory options. The future session identity contract, including broker-assigned identifiers, belongs to #19 and #28.

## Packed verification

Build and pack the package. Install the tarball and the pinned Node types into a clean ESM consumer. Copy the Node fixture and its tsconfig from `test/packed`. The packed browser launcher copies the DOM-only fixture and uses the locked `typescript-stable` alias to check both projects. The normal build, Node packed step and browser launcher use the 7.1 beta compiler. The fixtures check contextual callbacks, mutable platform payloads, QoS discriminants and invalid publish options. The browser tsconfig uses an empty `types` list.

Run Publint 0.3.25 and Are the Types Wrong 0.18.5 against the tarball. Use the latter's `esm-only` profile for the package's ESM and bundler resolution modes. The profile excludes Node 10 and CommonJS resolution modes.

Refs #50.

## Session end

Set `onSessionEnd` on a TCP, Node WebSocket, browser or portable client to observe its first MQTT retirement. The observer runs after pending protocol work has been retired. It can run during MQTT connection setup if the transport has already reached the portable session. Use the `connect()` rejection for failures before that point.

- `{ kind: 'disconnect' }` means the local MQTT DISCONNECT write completed and won the retirement race. An application queue can drain its admitted messages. The native socket may still be closing, so await `disconnect()` for that result.
- `{ kind: 'error', error }` carries the original Error used to retire protocol work. A broker DISCONNECT, transport close, cancellation and protocol failure can all produce this outcome. Treat the error as application data. Use `onDiagnostic` for redacted command and state metadata.

The callback is queued once. Its return value never delays socket closure or protocol settlement, and thrown or rejected callbacks leave the first outcome intact. Application cancellation of a message consumer is separate from cancellation of its session.

`TcpTlsOptions` names the native CA, client certificate, key and servername settings accepted by `TcpClientOptions.tls`. See the [TCP TLS guide](tcp-tls.md).
