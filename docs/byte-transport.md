# Byte transport and transport core

The supported TCP client runs on a byte-level transport contract and a shared transport core. Both are private for now. The `ws` client and the browser client move onto them in later steps of [#171](https://github.com/dvkam/mqtt/issues/171), and step 5 makes the contract public. The decisions behind this shape are in [design-decisions.md](design-decisions.md).

## Contract

`src/byteTransport.ts` defines it. A transport has a `name` and an `open(inbound, context)` function.

- The core creates the read side, `ByteInbound`, before it calls `open`. The transport calls `bytes(chunk)` for received bytes, `end(reason)` when the peer finished or the connection closed, and `fail(error)` when the transport broke.
- `context.signal` aborts when the core gives up on the attempt. The opener then releases its connection and rejects. `context.timeoutMs` is the opener's own deadline for establishing the connection.
- `open` resolves with a write-only `ByteWriter`: `bufferedBytes`, an optional `frameOverhead(length)`, `write(chunk)` and `close(force)`. `write` hands the chunk to the native layer before it returns, so writes keep their order.

The core needs the name before a writer exists, because an abort during the open reports `<name> connection aborted` when the signal's reason is not an Error. That is why `name` sits on the transport and not on the writer, unlike the first sketch in #171.

## What the core owns

`src/transportCore.ts` holds `createByteClient(transport, options)`. It returns the same cached `ClientFactory` the built-in factories return, and does the following for one connection attempt:

- It validates the options before it opens anything.
- It frames and checks inbound packets through the Node framer and its inbound rules.
- It applies the write budget: `bufferedBytes` plus `frameOverhead` must fit before a write. A refusal rejects with `<name> write budget exceeded`, and a refused QoS 1 publication leaves the session usable.
- It handles the caller's abort signal and force-closes the writer after a remote end, a transport failure, rejected input or an abort.
- If the open rejects, it reports the first failure the transport delivered to `inbound`, and otherwise the rejection.

The TCP opener in `src/tcpClient.ts` creates the socket, maps its `data`, `end`, `close` and `error` events to `ByteInbound`, and owns the connection timeout and the messages that name TCP or TLS.

## Conformance suite

`test/byte-transport-conformance.test.ts` runs the same cases over an in-memory transport and over a Node `Duplex` adapted in about 30 lines. The cases cover a publication split into single bytes, a graceful disconnect, a remote end, a transport failure, AUTH answered with DISCONNECT 0x82, the packet limit and an abort. Cases that need control of the writer run over the in-memory transport: the write budget, frame overhead, aborts and failures during the open, a writer that arrives after the transport ended, and the factory opening once.

The core still uses the Node framer and delivers Buffer payloads. Generalizing the payload type is part of the browser step.
