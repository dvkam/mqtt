# Browser MQTT client preview

`createBrowserClient` opens the browser's native WebSocket with the `mqtt` subprotocol and runs it on the shared [byte transport core](byte-transport.md), the same core as the TCP and Node WebSocket clients. It frames with the portable framer and delivers `Uint8Array` payloads.

```ts
import { createBrowserClient } from 'mqtt/browser';

const client = await createBrowserClient({
  url: 'wss://broker.example/mqtt',
  clientId: 'example',
  timeoutMs: 3000,
  maxBufferedBytes: 1024 * 1024,
  maxPacketBytes: 1024 * 1024,
  maxWebSocketMessageBytes: 1024 * 1024,
  onMessage(message) {
    console.log(message.topic, message.payload.byteLength);
  },
}).connect();

try {
  await client.subscribe('example/reply');
  await client.publish('example/request', 'hello');
  await client.ping();
} finally {
  await client.disconnect();
}
```

Construction performs no I/O. Repeated `connect` calls on one factory return the same promise. Use a new factory for another connection attempt.

## Credentials

Pass `username` and `password` to authenticate. `password` is a string, which the client sends as its UTF-8 bytes, or a `Uint8Array`, which it copies when `connect()` starts. MQTT 5 allows a password without a username. A password over 65,535 bytes rejects `connect()` with `ERR_MQTT_INVALID_ARGUMENT` before the socket opens. A broker that refuses the credentials rejects it with `ERR_MQTT_REFUSED`. `reasonCode` holds the broker's reason, such as 0x86, Bad User Name or Password, or 0x87, Not authorized.

```ts
const client = await createBrowserClient({ url: 'wss://broker.example/mqtt', clientId: 'example', username: 'sensor-7', password: token }).connect();
```

Browsers send these credentials inside the MQTT CONNECT packet over the WebSocket. Use `wss://` so they are encrypted in transit, and do not ship long-lived secrets in a public bundle. Diagnostics never include credentials.

The preview opens an MQTT 5 clean session with Keep Alive `0` in CONNECT and honors a positive [Server Keep Alive](deadlines.md#server-keep-alive) override. It supports ordinary QoS 0 and 1 subscriptions, text and byte [publishing](publishing.md) with retain and the MQTT 5 PUBLISH properties, binary received payloads, ping and graceful disconnect. A received message carries every PUBLISH property the broker sent as a flat field. User Properties keep their order and duplicates. [Public client types](public-types.md#received-message-fields) lists the fields. The codec profile in docs/codec.md defines the accepted broker packets and properties.

The shared session rejects empty subscription filters, misplaced wildcards, NUL, lone UTF-16 surrogates and filters exceeding 65,535 UTF-8 bytes before reserving an identifier or sending. Invalid input leaves an active session usable. An existing terminal failure retains precedence. Valid Unicode pairs, byte-order marks and exact byte-limit filters preserve their original text. Publishing applies the same string limits and rejects both wildcard characters before sending. Invalid publication input leaves the session usable. Topic aliases and shared-subscription negotiation remain outside this API.

Subscriptions can run concurrently with independent identifiers. The [subscription guide](concurrent-subscriptions.md) defines maxPendingSubscriptions, maxPendingSubscriptionBytes, acknowledgment ownership and refusal behavior.

The optional signal applies while opening and during the active connection. Cancellation rejects pending operations and prevents later writes. Cancellation that wins before the final connection handoff rejects `connect`.

The [inbound publication checks](inbound-publication-validation.md) cover empty names, wildcards and unnegotiated Topic Aliases.

The supported TCP, Node WebSocket and browser clients reject CONNECT, SUBSCRIBE, UNSUBSCRIBE and PINGREQ packets from the broker on their first byte, with protocol error `0x82`. They stop processing at that packet and attempt to send DISCONNECT after a successful CONNACK, while the client is still open. The standalone codec can decode packets from both directions. [MQTT 5 sections 2.1.2 and 4.13](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

An empty client ID requires a nonempty server assignment on successful CONNACK. The browser adapter forwards that identifier for the shared session's agreement check. Unsolicited authentication remains unsupported. [Connection agreement](connack-agreement.md) documents the rules, refusal handling and identity-consistency policy.

A peer close completes the framer. If MQTT input ends inside a packet, pending operations reject with the truncation error. A clean packet boundary retains the transport close reason. Local disconnect, cancellation, an operation timeout and earlier errors stop the framer instead and keep their original outcome, even with partial input.

The browser client applies the same inbound rules as the Node clients. The owner decided this on 16 November 2026, and [design-decisions.md](design-decisions.md) records it.

- AUTH is a protocol error with reason code 0x82, and the client sends DISCONNECT.
- A QoS 0 PUBLISH with DUP set is a protocol error with 0x81, also with DISCONNECT.
- A QoS 1 PUBLISH without a QoS 1 handler is dropped, and no PUBACK is sent.
- A QoS 2 PUBLISH is dropped without a QoS 1 handler. With a QoS 1 handler it ends the session with `Unsupported incoming MQTT PUBLISH`.
- PUBREC, PUBREL and PUBCOMP are ignored.
- A fixed header with invalid flags fails on its first byte.

`test/browser-core-changes.test.ts` pins each change from the earlier browser client.

Write admission and per-packet receive allocation have separate budgets. A successful QoS 0 publish means local send admission. The [QoS 1 publishing](qos1-publish.md) and [delivery](qos1-receive.md) guides describe their separate acknowledgment contracts.

The browser client also limits aggregate incoming WebSocket messages with maxWebSocketMessageBytes. The default is twice maxPacketBytes, or two MiB with the default packet limit. A larger batch retires the connection before decoder entry, including a batch whose prefix contains a valid acknowledgment. Pending operations and later writes receive the original RangeError. It takes precedence over partial MQTT input discarded during cleanup. The limit accepts integers from 1 through 2,147,483,647 and is checked before the socket opens. An exact-limit message is admitted, and a text message fails the session. The browser has already reassembled, and possibly decompressed, a message before the client sees it. So the limit bounds the library's own work, not browser allocation, total receive memory or network backpressure. WebSocket protocol fragments count together, while MQTT fragments sent as separate WebSocket messages are checked one by one. Per-packet maxPacketBytes still applies to MQTT assembled across multiple admitted messages.

A failed ping retires the session before another ping can reuse the acknowledgment slot. Forced retirement starts native close but settles locally, so a silent peer adds no second native-close deadline to the operation timeout. Graceful disconnect waits for native closure up to the operation timeout. A browser cannot cut a WebSocket off, so after that the client stops waiting and resolves. Before step 4 of #171 it rejected with `MQTT WebSocket close timed out`.

Browser TLS trust, client certificates and proxy settings belong to the browser. The packed tests exercise the public client against Mosquitto over WS, WSS through an HTTP/1.1 TLS gateway and a CONNECT proxy.

The packed Vite SSR check covers import and factory construction with WebSocket, window, document and navigator absent. It exercises Vite's default externalized dependency and ssr.noExternal with mqtt bundled. Import and construction start no connection. Create a factory per application session and call connect from the application's client startup hook. Server rendering, hydration, framework lifecycle and server-side connection policy need their own application handling. This check does not claim those behaviors.

The [playground](../playground/README.md) runs the browser client in a page against a scripted broker or a local Mosquitto. Page lifecycle handling for [reconnecting](reconnect.md) is tracked in #32. QoS 2, a public Web Streams facade and wider browser verification remain in #8 and #37. The bounded consumption experiment and its remaining lifecycle work are documented in docs/message-stream-comparison.md and #54.
