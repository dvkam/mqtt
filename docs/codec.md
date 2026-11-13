# Portable MQTT 5 codec preview

Import `encodePacket` and `PacketDecoder` from `mqtt/codec`. They use Uint8Array, TextEncoder and TextDecoder and have no runtime dependencies.

```ts
import { encodePacket, PacketDecoder } from 'mqtt/codec';

const decoder = new PacketDecoder({ maxPacketBytes: 1024 * 1024 });
const connectBytes = encodePacket({ cmd: 'connect', clientId: 'example' });
const packets = decoder.push(Uint8Array.of(0x20, 3, 0, 0, 0));
```

Send encoded bytes through `openBrowserTransport` and feed its `onBytes` values to the decoder. The packed integration test follows this path against Mosquitto in Node and Chromium. The public `createBrowserClient` preview also combines this codec with the existing session lifecycle. A session owns acknowledgment ordering, legal packet phases, negotiated limits and reconnect behavior.

## Supported profile

| Packet               | Supported fields                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| CONNECT              | MQTT 5, client identifier, Clean Start, Keep Alive, Receive Maximum, username, binary password, User Properties                                 |
| CONNACK              | Session Present, reason code and every CONNACK property in MQTT 5 section 3.2.2.3                                                              |
| PUBLISH              | QoS 0 or 1, nonempty topic name, binary payload, retain, Payload Format Indicator, Message Expiry Interval, Content Type, Response Topic, Correlation Data, Subscription Identifiers, User Properties. QoS 1 also carries a nonzero packet identifier and DUP. |
| PUBACK               | Nonzero packet identifier, reason code, Reason String and ordered User Properties                                                               |
| SUBSCRIBE            | Packet identifier, ordinary topic filters with a uniform requested QoS of 0 or 1, User Properties                                               |
| SUBACK               | Packet identifier, reason codes, Reason String, User Properties                                                                                 |
| UNSUBSCRIBE          | Packet identifier, ordinary topic filters, User Properties                                                                                      |
| UNSUBACK             | Packet identifier, reason codes, Reason String, User Properties                                                                                 |
| PINGREQ and PINGRESP | Empty bodies                                                                                                                                    |
| DISCONNECT           | Every reason code in MQTT 5 section 3.14.2.1, Reason String, Server Reference, User Properties. Zero- and one-byte bodies when no property is present. |

User Properties are ordered key/value tuples. Duplicate keys and empty keys or values are preserved.

The encoder checks packet fields against this profile. Wills, shared subscriptions, AUTH, QoS 2 and CONNECT properties other than Receive Maximum require profile expansion. The decoder accepts each property only in the packet types that MQTT 5 assigns it to. It rejects a repeated property other than User Property and Subscription Identifier. The browser client rejects a CONNACK that carries Authentication Method or Authentication Data. It does not yet pass the other new CONNACK and PUBLISH properties to the application.

Pass `qos: 1` and `messageId` on a QoS 1 PUBLISH. QoS 0 packets may omit `qos` and decode to their existing shape. PUBACK decodes the omitted reason as success and accepts explicit reasons with or without the zero Property Length field. Its encoder emits the shortest form for the supplied reason and properties.

The browser adapter forwards Receive Maximum, Maximum QoS and PUBACK identifiers and reason codes to the session. The [outbound QoS 1 guide](qos1-publish.md) describes quota and acknowledgment ownership. The [inbound QoS 1 guide](qos1-receive.md) describes the opt-in callback and receive window.

The encoder uses the compact two-byte normal DISCONNECT. mqtt-packet 9.0.2 regenerates the same operation with an explicit reason and empty properties. Both forms are valid under MQTT 5 section 3.14.

The Node TCP and WS/WSS adapters encode with this codec too. They pass `{ sharedSubscriptions: true }` to `encodePacket`, which then accepts a `$share/{name}/{filter}` filter with a nonempty share name that has no wildcard. The browser client does not set the flag.

The [inbound publication checks](inbound-publication-validation.md) describe invalid Topic Names and the zero inbound Topic Alias profile.

## Framing and memory

`push` accepts fragmented or coalesced frames and returns complete packets. It copies incoming bytes into an owned frame. Returned binary fields keep that frame alive and do not alias the caller's input.

On failure, `push` throws. Use `pushBatch` when a transport needs the complete packets before a malformed frame in the same chunk. It returns the packet array on success, or `{ packets, error }` with the valid prefix and the stored error. The decoder stops at the first failure. Later batches return the same error with an empty prefix. The browser client dispatches the complete prefix while the session owns input. An earlier refusal or direction error keeps its outcome. If the listener still owns input when the prefix ends, a classified decoder error can send a DISCONNECT notice. An unclassified error retires the byte transport directly.

The decoder validates Remaining Length and the per-packet limit before allocating a frame. Its default limit is 1 MiB, including the fixed header. Any decoding error permanently fails that decoder. Start a new decoder for a new connection.

The limit covers the frame byte allocation. It excludes decoded strings, property tuples, retained output, the returned packet array and transport buffers. A single call can return many packets. On connection closure, the session must reject any unfinished exchange.

Call `finish()` when byte input has ended, not after each chunk or WebSocket message. It succeeds only at a packet boundary and closes the decoder. Repeated successful calls are harmless. Later `push()` calls reject, including empty input. A partial fixed header, Remaining Length or body causes a truncation error and releases the buffered frame and header. That failure is permanent, and later `finish()` or `push()` calls throw the same error. A previous decode error keeps its original identity.

Packets already returned by `push()` remain valid if trailing input is truncated. `finish()` performs no I/O and does not wait for missing bytes. The browser client calls it once when its byte transport retires. A peer close with partial input rejects unfinished exchanges with the truncation error. Local disconnect, cancellation, transport errors and application callback errors keep their original outcome. Refusal and operation timeout also keep their earlier failure. Completion does not add a wait for native socket closure.

The browser byte transport passes an additional `BrowserCloseKind` argument to `onClose`. Its values are `remote`, `local`, `abort` and `error`. The first retirement determines the notification. A later native close does not notify again. Opening handshake failures occur before this byte transport owns input and do not complete a decoder.

The bounded CodecFrames model checks allocation admission, completion before emission and no output after failure. It abstracts complete header validation, byte content and copying. UTF-8, property rules and concrete fragmented parsing are covered by wire-vector tests.

The bounded CodecEndOfInput model checks truncation rejection, no output after successful completion and failure reporting on repeated completion. It uses five abstract states for an open boundary, partial header, partial body, successful end and failure. Sequential method calls and ordinary byte-view reads are assumptions. It does not prove packet conformance, garbage collection behavior or transport shutdown.

The [fixed-wire comparison](codec-comparison.md) records how the pinned decoders handle length encodings, AUTH and repeated User Properties.

## Initial measurements

Run `node test/bench/codec.ts` after building. The corpus is a QoS 0 PUBLISH with a 256-byte payload. Each operation has 1,000 warmup calls and 10,000 measured calls under Node 26.13.0. V8 allocation sampling runs during measurement, including objects collected by GC.

These are medians of three runs. Allocation samples include measurement overhead and are estimates rather than exact allocation counts or peak memory.

| Operation | Prototype operations/s | mqtt-packet 9.0.2 operations/s | Prototype sampled bytes | mqtt-packet sampled bytes |
| --------- | ---------------------- | ------------------------------ | ----------------------- | ------------------------- |
| Encode    | 84,770                 | 152,553                        | 33,897,800              | 23,673,872                |
| Decode    | 113,552                | 64,152                         | 25,561,384              | 51,438,720                |

Encoding is slower and allocates more in this workload. Decoding is faster with fewer sampled bytes. This corpus does not establish a general performance advantage. Keep raw measurements with the local research or CI artifacts when rerunning the benchmark.

The upstream mqtt-packet release checked for this work is v9.0.2. The v10 roadmap remains relevant to a later comparison with a published or pinned implementation. Profile expansion, broader differential cases, randomized wire inputs and package extraction remain in #37. The packed client-and-codec test harness reports its browser bundle size in CI.

The wire rules come from MQTT 5 sections 1.5, 2.1, 2.2 and 3.1 through 3.14. [MQTT 5 specification](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html) · [Upstream codec roadmap](https://github.com/mqttjs/mqtt-packet/issues/159)
