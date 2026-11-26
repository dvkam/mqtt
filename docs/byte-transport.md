# Byte transport and transport core

The supported TCP, `ws` and browser clients run on a byte-level transport contract and a shared transport core. Custom transports use the same contract through `createTransportClient` from `mqtt` or `mqtt/portable`. The core is private. The decisions behind this shape are in [design-decisions.md](design-decisions.md).

The [ownership map](transport-ownership.md) links connection, packet, exchange, and close behavior to the source and its checks.

## Contract

`src/byteTransport.ts` defines it. A transport has a `name`, an optional `supportsSharedSubscriptions` that defaults to true, and an `open(inbound, context)` function. When `supportsSharedSubscriptions` is false, the session refuses a `$share/` filter before it writes anything. An optional `supportsPassword`, also true by default, says whether CONNECT carries the `password` option. The browser sets it to false.

- The core creates the read side, `ByteInbound`, before it calls `open`. The transport calls `bytes(chunk)` for received bytes, `end(reason)` when the peer finished or the connection closed, and `fail(error)` when the transport broke.
- `context.signal` aborts when the core gives up on the attempt. The opener then releases its connection and rejects. An opener that awaits before it listens to the signal must check `signal.aborted` after each await, because an abort that already happened fires no event. `context.timeoutMs` is the opener's own deadline for establishing the connection. `context.maxPacketBytes` is the validated MQTT packet limit. The built-in WebSocket adapters use it to set their default message limit, and a custom adapter can use it to size its own receive limit.
- `open` resolves with a write-only `ByteWriter`: `bufferedBytes`, an optional `frameOverhead(length)`, `write(chunk)` and `close(force)`. `write` hands the chunk to the native layer before it returns, so writes keep their order, and rejects once the writer is closed. A browser `WebSocket.send()` on a closing socket drops the data silently, so a browser writer has to check the state itself.

The core builds three messages from the name: `<name> write budget exceeded`, `<name> connection aborted` when the abort reason is not an Error, and `<name> connection closed` when `end` gets no reason. It needs the name before a writer exists, because an abort can land during the open. That is why `name` sits on the transport and not on the writer, unlike the first sketch in #171. The `ws` transport is named `WebSocket`, so its budget message stays `WebSocket write budget exceeded`. Its own messages, such as `MQTT WebSocket closed`, come from the opener and did not change.

Step 3 moved the `ws` client onto the core and kept the core's rules where they differed. The `ws` changes are listed in the pull request that made them:

- An abort whose reason is not an Error rejects with `WebSocket connection aborted`. It was `MQTT WebSocket aborted`.
- The core validates the timeout, the publication and subscription limits, the write limits and then the packet limit. The opener validates the WebSocket message limit after them. The `ws` client used to validate the write limits first and the message limit before the packet limit. This matters only when two options are invalid at once.
- When an attempt fails, the core reports the input's first failure or the session's error. The `ws` client used to report the abort reason instead whenever the caller had aborted. This differs only when the caller aborts after another failure was recorded.
- The core encodes the packet and applies the write budget before the writer checks the socket state. On a socket that is already closing, a write over the budget now reports the budget refusal instead of `MQTT WebSocket closed`, and an encoding failure would report itself. No test reaches the encoding case through the session, which reports its recorded failure first.

Only an end, a failure or fatal input during the open is kept for the session. A valid packet that arrives before the session listens is dropped. A broker sends nothing before CONNECT, and the session writes CONNECT after it listens.

`close(true)` must release the connection promptly and settle pending writes. The core sets no close deadline of its own. The TCP socket closes at once. The `ws` writer keeps its own deadline: a graceful close that the peer does not answer within the operation timeout becomes a forced one. Moving the deadline into the core would also give TCP a deadline it does not have. The owner decided on 18 November 2026 to keep the deadline in each writer: the browser writer gets its own, TCP stays without one, and the question comes back with the separate deadlines of the recommended order in #171.

## What the core owns

`src/transportCore.ts` holds `createByteClient(transport, options, platform)`. It returns the same cached `ClientFactory` the built-in factories return, and does the following for one connection attempt:

- It validates the options before it opens anything.
- It frames and checks inbound packets with the framer the platform supplies, and applies the inbound rules.
- It applies the write budget: `bufferedBytes` plus `frameOverhead` must fit before a write. A refusal rejects with `<name> write budget exceeded`, and a refused QoS 1 publication leaves the session usable.
- It handles the caller's abort signal and force-closes the writer after a remote end, a transport failure, rejected input or an abort. It starts one forced close per writer and shares its settlement with session shutdown. It removes the signal listener when a forced close starts or a graceful close settles. A transport failure can escalate a graceful close.
- If the open rejects, it reports the first failure the transport delivered to `inbound`, and otherwise the rejection.

The TCP opener in `src/tcpClient.ts` creates the socket, maps its `data`, `end`, `close` and `error` events to `ByteInbound`, and owns the connection timeout and the messages that name TCP or TLS. The `ws` opener in `src/websocketClient.ts` creates the WebSocket with the `mqtt` subprotocol, maps `message`, `close` and `error`, rejects text messages and owns the close deadline. `ws` itself refuses a handshake response without the `mqtt` subprotocol. The browser opener in `src/browserClient.ts` opens the native WebSocket through `openMqttWebSocket`, maps `message`, `error` and `close`, checks the message limit, rejects text messages and stops listening once the socket or the core closes it. Its writer rejects a write on a socket that is not open, because `WebSocket.send()` on a closing socket drops data silently, and it owns its close deadline: a graceful close the peer does not finish within the operation timeout stops waiting. It reports no frame overhead, as the browser client before it did not.

## Conformance suite

`test/byte-transport-conformance.test.ts` runs the same cases over an in-memory transport and over a Node `Duplex` adapted in about 30 lines. The shared cases cover a publication split into single bytes, a graceful disconnect, a remote end, a close without an end or an error, a transport failure, AUTH answered with DISCONNECT 0x82, the packet limit and an abort. Cases that need control of the writer or the open run over the in-memory transport: the write budget, frame overhead, a refused connection, a forced close after a protocol error, no write after the transport ended, a failed write, a close that throws, a graceful close followed by a remote end or by a transport failure, aborts, failures and invalid input during the open, a writer that arrives after the transport ended, and the factory opening once.

## Platforms

`createByteClient(transport, options, platform)` takes a `BytePlatform` (`src/bytePlatform.ts`): a `framer` factory and a `bytes` view for payloads and byte properties. The core imports no platform, so it bundles for Node and for a browser.

- `nodePlatform` (`src/nodePlatform.ts`) frames each packet into one unpooled Buffer and delivers Buffer payloads. The TCP and `ws` clients use it.
- `portablePlatform` (`src/portablePlatform.ts`) frames into plain `Uint8Array`s and delivers them as they are. The browser client uses it from step 4.

The generic input is `PacketInput` (`src/packetInput.ts`), and the inbound rules are `inboundPacketListener` (`src/inboundPackets.ts`). `NodePacketInput` and `nodePacketListener` are their Node versions.

A conformance case bundles the core and `portablePlatform` with Vite for a browser and fails on any import outside the bundle, any dynamic import, and any `Buffer`, `node:` or browser-external stub in the output. That is the rule the packed browser check applies to the packed package. The shared conformance cases also run over the in-memory transport with `portablePlatform` and check that payloads are not Buffers.
