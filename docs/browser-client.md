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

The optional signal applies while opening and during the active connection. Cancellation rejects pending operations and prevents later writes. Cancellation that wins before the final connection handoff rejects `connect`.

A peer close completes the decoder. If MQTT input ends inside a packet, pending operations reject with the truncation error. A clean packet boundary retains the transport close reason. Local disconnect, cancellation and earlier errors keep their original outcome, even with partial input. Decoder completion runs once and does not wait for another message.

Write admission and per-packet receive allocation have separate budgets. A successful publish means local send admission. The session does not claim broker receipt for QoS 0.

A failed ping retires the session before another ping can reuse the acknowledgment slot. Forced retirement starts native close but settles locally, so a silent peer adds no second native-close deadline to the operation timeout. Eventual native-close failure is observed in the background. Graceful disconnect still waits for native closure or its deadline.

Browser TLS trust, client certificates and proxy settings belong to the browser. The packed tests exercise the public client against Mosquitto over WS, WSS through an HTTP/1.1 TLS gateway and a CONNECT proxy.

Password authentication in the public client, binary publishing, additional MQTT properties, QoS 1/2, reconnect, Web Streams, SSR and wider browser verification remain in #8 and #37.
