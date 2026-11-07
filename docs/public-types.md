# Public client types

Import supported Node types from `mqtt` and browser types from `mqtt/browser`. These are type-only exports and do not open a connection.

| Type | Entry point | Contract |
| --- | --- | --- |
| `TcpClientOptions` | `mqtt` | Host, optional port, session options and cancellation signal |
| `WebSocketClientOptions` | `mqtt` | URL, TLS and agent options, session options and local write budget |
| `NodeMessage` | `mqtt` | Received QoS 0 PUBLISH with a mutable Buffer payload |
| `BrowserClientOptions` | `mqtt/browser` | URL, session identity, cancellation and independent byte/packet budgets |
| `BrowserMessage` | `mqtt/browser` | Received QoS 0 PUBLISH with a mutable Uint8Array payload |
| `ClientFactory` | Both | One cached connection attempt through `connect()` |
| `ClientSession` | Both | Subscribe, text publish, ping and disconnect promises |
| `BrowserSession` | `mqtt/browser` | Retained alias for `ClientSession` |

`PortableOptions` is available from the experimental `mqtt/portable` entry point. Node option interfaces extend its named contract instead of extracting parameters from an internal generic function. The low-level packet transport still uses mqtt-packet declarations; this change does not settle its future codec contract.

Callbacks infer their platform's receive payload. Publishing remains text-only. Received Node messages use Buffer because that is the pinned parser's decoded representation; the parser's shared input/output packet type also permits strings for encoding. A Node listener checks QoS and Buffer shape before exposing a publication through the precise callback. It forwards accepted packet objects and buffers without copying or freezing them. The preview continues to ignore unsupported incoming QoS 1/2 publications rather than implementing their acknowledgment flow.

Node and browser factories share a dependency-free session interface. Browser declarations do not import Node globals or native transports. The existing browser session name remains usable, and repeated factory `connect()` calls preserve promise identity.

Compiler fixtures check valid options, contextual callbacks, specific payload types, QoS 0, mutable payload operations and invalid scalar combinations. Packed consumer checks import the names from the installed tarball. The browser fixture compiles with DOM declarations and no Node ambient types.

This is part of #50. Minimum consumer compiler policy, named error contracts, package validators and wider public type-boundary work remain open. Legacy options are documented separately in `legacy-options.md`.
