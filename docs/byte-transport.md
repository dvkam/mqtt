# Byte transport and transport core

The supported TCP and `ws` clients run on a byte-level transport contract and a shared transport core. Both are private for now. The browser client moves onto them in step 4 of [#171](https://github.com/dvkam/mqtt/issues/171), and step 5 makes the contract public. The decisions behind this shape are in [design-decisions.md](design-decisions.md).

## Contract

`src/byteTransport.ts` defines it. A transport has a `name` and an `open(inbound, context)` function.

- The core creates the read side, `ByteInbound`, before it calls `open`. The transport calls `bytes(chunk)` for received bytes, `end(reason)` when the peer finished or the connection closed, and `fail(error)` when the transport broke.
- `context.signal` aborts when the core gives up on the attempt. The opener then releases its connection and rejects. An opener that awaits before it listens to the signal must check `signal.aborted` after each await, because an abort that already happened fires no event. `context.timeoutMs` is the opener's own deadline for establishing the connection.
- `open` resolves with a write-only `ByteWriter`: `bufferedBytes`, an optional `frameOverhead(length)`, `write(chunk)` and `close(force)`. `write` hands the chunk to the native layer before it returns, so writes keep their order, and rejects once the writer is closed. A browser `WebSocket.send()` on a closing socket drops the data silently, so a browser writer has to check the state itself.

The core builds three messages from the name: `<name> write budget exceeded`, `<name> connection aborted` when the abort reason is not an Error, and `<name> connection closed` when `end` gets no reason. It needs the name before a writer exists, because an abort can land during the open. That is why `name` sits on the transport and not on the writer, unlike the first sketch in #171. The `ws` transport is named `WebSocket`, so its budget message stays `WebSocket write budget exceeded`. Its own messages, such as `MQTT WebSocket closed`, come from the opener and did not change.

Step 3 moved the `ws` client onto the core and kept the core's rules where they differed. The `ws` changes are listed in the pull request that made them:

- An abort whose reason is not an Error rejects with `WebSocket connection aborted`. It was `MQTT WebSocket aborted`.
- The core validates the timeout, the publication and subscription limits, the write limits and then the packet limit. The opener validates the WebSocket message limit after them. The `ws` client used to validate the write limits first and the message limit before the packet limit. This matters only when two options are invalid at once.
- When an attempt fails, the core reports the input's first failure or the session's error. The `ws` client used to report the abort reason instead whenever the caller had aborted. This differs only when the caller aborts after another failure was recorded.
- The core applies the write budget before the writer checks the socket state. On a socket that is already closing, a write over the budget now reports the budget refusal instead of `MQTT WebSocket closed`.

Only an end, a failure or fatal input during the open is kept for the session. A valid packet that arrives before the session listens is dropped. A broker sends nothing before CONNECT, and the session writes CONNECT after it listens.

`close(true)` must release the connection promptly and settle pending writes. The core sets no close deadline of its own. The TCP socket closes at once. The `ws` writer keeps its own deadline: a graceful close that the peer does not answer within the operation timeout becomes a forced one. Moving the deadline into the core would also give TCP a deadline it does not have, so that question moves to step 4, where the browser takes on the same escalation.

## What the core owns

`src/transportCore.ts` holds `createByteClient(transport, options)`. It returns the same cached `ClientFactory` the built-in factories return, and does the following for one connection attempt:

- It validates the options before it opens anything.
- It frames and checks inbound packets through the Node framer and its inbound rules.
- It applies the write budget: `bufferedBytes` plus `frameOverhead` must fit before a write. A refusal rejects with `<name> write budget exceeded`, and a refused QoS 1 publication leaves the session usable.
- It handles the caller's abort signal and force-closes the writer after a remote end, a transport failure, rejected input or an abort. A transport failure force-closes the writer even after a graceful close started.
- If the open rejects, it reports the first failure the transport delivered to `inbound`, and otherwise the rejection.

The TCP opener in `src/tcpClient.ts` creates the socket, maps its `data`, `end`, `close` and `error` events to `ByteInbound`, and owns the connection timeout and the messages that name TCP or TLS. The `ws` opener in `src/websocketClient.ts` creates the WebSocket with the `mqtt` subprotocol, maps `message`, `close` and `error`, rejects text messages and owns the close deadline. `ws` itself refuses a handshake response without the `mqtt` subprotocol.

## Conformance suite

`test/byte-transport-conformance.test.ts` runs the same cases over an in-memory transport and over a Node `Duplex` adapted in about 30 lines. The shared cases cover a publication split into single bytes, a graceful disconnect, a remote end, a close without an end or an error, a transport failure, AUTH answered with DISCONNECT 0x82, the packet limit and an abort. Cases that need control of the writer or the open run over the in-memory transport: the write budget, frame overhead, a refused connection, a forced close after a protocol error, no write after the transport ended, a failed write, a close that throws, a graceful close followed by a remote end, aborts, failures and invalid input during the open, a writer that arrives after the transport ended, and the factory opening once.

The core still uses the Node framer and delivers Buffer payloads. Generalizing the payload type is part of the browser step.
