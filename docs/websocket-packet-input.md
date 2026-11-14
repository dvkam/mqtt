# Node WebSocket packet input

`createWebSocketClient` uses the same private bounded decoder and input helper as TCP. It parses each frame with the portable codec and keeps mutable Buffer payloads. The browser client continues to use the portable codec; accepted packet profiles have not converged.

```ts
import { createWebSocketClient } from 'mqtt';

const factory = createWebSocketClient({
  url: 'wss://broker.example/mqtt',
  clientId: 'bounded-websocket',
  maxPacketBytes: 1024 * 1024,
  maxWebSocketMessageBytes: 1024 * 1024,
});
```

Factory construction performs no I/O. Call `factory.connect()` to start the MQTT session. The README describes operations and disconnect. TLS certificates and caller-supplied agents retain their existing behavior.

## Independent limits

`maxPacketBytes` defaults to 1,048,576 and accepts integers from 2 through 268,435,460. It counts the actual total MQTT wire size, including the first byte and encoded Remaining Length. The client rejects invalid configuration before accessing the URL or constructing a WebSocket. An already-aborted signal retains its existing precedence.

`maxWebSocketMessageBytes` separately limits each assembled binary WebSocket message. It defaults to 1,048,576 and accepts integers from 1 through 2,147,483,647. ws enforces this through maxPayload, before the MQTT input helper receives the message. Compression remains disabled.

A broker can split an MQTT packet across many individually admitted WebSocket messages. The packet limit spans those messages and rejects an oversized declaration before waiting for a body. Conversely, several MQTT packets can share one message, so a valid packet does not bypass the message limit. Tests accept an eight-byte MQTT publication delivered as eight one-byte WebSocket messages. Separate tests reject a native message excess and a packet excess with distinct causes.

These are local receive limits, not negotiated Maximum Packet Size, outgoing limits, application queue limits or total-memory bounds. Compact assembly can reserve the admitted remainder before its body arrives. Native message assembly, decoded objects, strings, consumer retention and socket buffers require separate accounting.

## Ownership and closure

The [TCP guide](tcp-packet-input.md) defines the shared compact copying and terminal provenance. Each admitted packet has owned remainder storage. Delivered payloads remain mutable Buffer views into that compact storage. Transferring a payload's backing ArrayBuffer cannot detach the coalesced message that still contains protocol replies. The transfer regression uses in-process structuredClone, not a worker deployment test.

The adapter records decoder errors, native errors, text rejection and abort before requesting termination. Pending operations and immediate later operations see the established cause. A native message-limit error keeps its native error code, including when earlier MQTT input was partial. Callback abort stops another coalesced body allocation. Core unlisten stops decoding while keeping its private cleanup Error hidden.

The exposed remote-completion event is WebSocket close. If input is still open, close completes MQTT decoding and reports truncation for a partial packet. An earlier error, abort or core-owned timeout/disconnect prevents reclassification. This does not inherit TCP's readable-end guarantee for blocked writes. No private ws receiver hook is used. Native-close cleanup releases the signal and settles the close promise in a finally block.

Completed application publications can precede a later failing declaration in the same message. A pending successful acknowledgment prefix can still lose to fatal input in that callback. A matching refused CONNACK establishes refusal synchronously, so trailing partial input or close cannot replace its code. Operations already settled in an earlier turn keep their result.

## Evidence

Public tests cover invalid settings before URL access, declaration-only rejection, one-byte messages, fragmented lengths, exact limits, native WebSocket fragmentation, acknowledgment prefixes, partial EOF, refusal, timeout, abort, disconnect, text rejection and compact Buffer ownership. A native-client check requires packet rejection to reach CLOSED before peer cleanup. The installed-package probe repeats capacity, split-message, EOF and Buffer checks through the public export. Packed WS/WSS broker sessions set an explicit packet cap.

NodePacketAdmission and NodeInputLifecycle map to the shared decoder/helper. Existing NodeReceive and NodeCancellation models cover native message limits and signal ownership. The models do not prove native parser conformance, actual buffer ownership, exact Error identity, physical closure or timing. Concrete tests and wire probes supply the relevant observations. The [measurement index](measurements.md) links each measured workload and its limits.

The #75 admission decision uses compact assembly for both supported Node adapters. It adds bounded admission and compact retention while preserving the sampled Node packet profile. The measured contiguous-input cost remains documented. Broader malformed-packet rules remain #9, negotiated behavior #16, and repeatable performance thresholds #18.
