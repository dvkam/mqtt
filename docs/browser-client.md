# Browser MQTT client preview

`createBrowserClient` combines the native browser byte transport, the portable MQTT 5 codec and the existing session lifecycle.

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

The preview opens an MQTT 5 clean session with Keep Alive set to zero. It supports ordinary QoS 0 subscriptions, text publishing, binary received payloads, ping and graceful disconnect. Received User Properties retain their key/value order and duplicates. The codec profile in docs/codec.md defines the accepted broker packets and properties.

The shared session rejects empty subscription filters, misplaced wildcards, NUL, lone UTF-16 surrogates and filters exceeding 65,535 UTF-8 bytes before reserving an identifier or sending. Invalid input leaves an active session usable. An existing terminal failure retains precedence. Valid Unicode pairs, byte-order marks and exact byte-limit filters preserve their original text. Publishing applies the same string limits and rejects both wildcard characters before sending. Invalid publication input leaves the session usable. Topic aliases and shared-subscription negotiation remain outside this API.

Subscriptions can run concurrently with independent identifiers. The [subscription guide](concurrent-subscriptions.md) defines maxPendingSubscriptions, maxPendingSubscriptionBytes, acknowledgment ownership and refusal behavior.

The optional signal applies while opening and during the active connection. Cancellation rejects pending operations and prevents later writes. Cancellation that wins before the final connection handoff rejects `connect`.

A peer close completes the decoder. If MQTT input ends inside a packet, pending operations reject with the truncation error. A clean packet boundary retains the transport close reason. Local disconnect, cancellation and earlier errors keep their original outcome, even with partial input. Decoder completion runs once and does not wait for another message.

Write admission and per-packet receive allocation have separate budgets. A successful publish means local send admission. The session does not claim broker receipt for QoS 0.

The browser client also limits aggregate incoming WebSocket messages with maxWebSocketMessageBytes. The default is one MiB. A larger batch retires the connection before decoder entry, including a batch whose prefix contains a valid acknowledgment. Pending operations and later writes receive the original RangeError. It takes precedence over partial MQTT input discarded during cleanup. The byte transport guide defines its supported range, fragmentation behavior and memory exclusions. Per-packet maxPacketBytes still applies to MQTT assembled across multiple admitted messages.

A failed ping retires the session before another ping can reuse the acknowledgment slot. Forced retirement starts native close but settles locally, so a silent peer adds no second native-close deadline to the operation timeout. Eventual native-close failure is observed in the background. Graceful disconnect still waits for native closure or its deadline.

Browser TLS trust, client certificates and proxy settings belong to the browser. The packed tests exercise the public client against Mosquitto over WS, WSS through an HTTP/1.1 TLS gateway and a CONNECT proxy.

The packed Vite SSR check covers import and factory construction with WebSocket, window, document and navigator absent. It exercises Vite's default externalized dependency and ssr.noExternal with mqtt bundled. Import and construction start no connection. Create a factory per application session and call connect from the application's client startup hook. Server rendering, hydration, framework lifecycle and server-side connection policy need their own application handling. This check does not claim those behaviors.

Password authentication in the public client, binary publishing, additional MQTT properties, QoS 1/2, reconnect, a public Web Streams facade and wider browser verification remain in #8 and #37. The bounded consumption experiment and its remaining lifecycle work are documented in docs/message-stream-comparison.md and #54.
