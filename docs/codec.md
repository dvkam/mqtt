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

| Packet | Supported fields |
| --- | --- |
| CONNECT | MQTT 5, client identifier, Clean Start, Keep Alive, username, binary password, User Properties |
| CONNACK | Session Present, reason code, Receive Maximum, Topic Alias Maximum, User Properties |
| PUBLISH | QoS 0, nonempty topic name, binary payload, retain, User Properties |
| SUBSCRIBE | Packet identifier, ordinary topic filters requesting QoS 0, User Properties |
| SUBACK | Packet identifier, reason codes, Reason String, User Properties |
| PINGREQ and PINGRESP | Empty bodies |
| DISCONNECT | Normal disconnect, accepting the zero-, one- and two-byte body abbreviations |

User Properties are ordered key/value tuples. Duplicate keys and empty keys or values are preserved.

Encoder objects are checked for unsupported fields. QoS 1, Wills, reasoned disconnects, shared subscriptions, additional properties and other packet types need explicit additions to this profile. Unsupported incoming fields fail decoding. Brokers may send valid MQTT 5 properties that this preview rejects.

The encoder uses the compact two-byte normal DISCONNECT. mqtt-packet 9.0.2 regenerates the same operation with an explicit reason and empty properties. Both forms are valid under MQTT 5 section 3.14.

## Framing and memory

`push` accepts fragmented or coalesced frames and returns complete packets. It copies incoming bytes into an owned frame. Returned binary fields keep that frame alive and do not alias the caller's input.

The decoder validates Remaining Length and the per-packet limit before allocating a frame. Its default limit is 1 MiB, including the fixed header. Any decoding error permanently fails that decoder. Start a new decoder for a new connection.

The limit covers the frame byte allocation. It excludes decoded strings, property tuples, retained output, the returned packet array and transport buffers. A single call can return many packets. On connection closure, the session must reject any unfinished exchange.

Call `finish()` when byte input has ended, not after each chunk or WebSocket message. It succeeds only at a packet boundary and closes the decoder. Repeated successful calls are harmless. Later `push()` calls reject, including empty input. A partial fixed header, Remaining Length or body causes a truncation error and releases the buffered frame and header. That failure is permanent, and later `finish()` or `push()` calls throw the same error. A previous decode error keeps its original identity.

Packets already returned by `push()` remain valid if trailing input is truncated. `finish()` performs no I/O and does not wait for missing bytes. Transport adapters still need to call it at actual end of input. Browser close integration remains under #8 and #37; this change adds the codec API rather than changing adapter close reasons.

The bounded CodecFrames model checks allocation admission, completion before emission and no output after failure. It abstracts complete header validation, byte content and copying. UTF-8, property rules and concrete fragmented parsing are covered by wire-vector tests.

The bounded CodecEndOfInput model checks truncation rejection, no output after successful completion and failure reporting on repeated completion. It uses five abstract states for an open boundary, partial header, partial body, successful end and failure. Sequential method calls and ordinary byte-view reads are assumptions. It does not prove packet conformance, garbage collection behavior or transport shutdown.

## Initial measurements

Run `node test/bench/codec.mjs` after building. The corpus is a QoS 0 PUBLISH with a 256-byte payload. Each operation has 1,000 warmup calls and 10,000 measured calls under Node 26.13.0. V8 allocation sampling runs during measurement, including objects collected by GC.

These are medians of three runs. Allocation samples include measurement overhead and are estimates rather than exact allocation counts or peak memory.

| Operation | Prototype operations/s | mqtt-packet 9.0.2 operations/s | Prototype sampled bytes | mqtt-packet sampled bytes |
| --- | --- | --- | --- | --- |
| Encode | 84,770 | 152,553 | 33,897,800 | 23,673,872 |
| Decode | 113,552 | 64,152 | 25,561,384 | 51,438,720 |

Encoding is slower and allocates more in this workload. Decoding is faster with fewer sampled bytes. This corpus does not establish a general performance advantage. Keep raw measurements with the local research or CI artifacts when rerunning the benchmark.

The upstream mqtt-packet release checked for this work is v9.0.2. The v10 roadmap remains relevant to a later comparison with a published or pinned implementation. Profile expansion, broader differential cases, randomized wire inputs and package extraction remain in #37. The packed client-and-codec test harness reports its browser bundle size in CI.

The wire rules come from MQTT 5 sections 1.5, 2.1, 2.2 and 3.1 through 3.14. [MQTT 5 specification](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html) · [Upstream codec roadmap](https://github.com/mqttjs/mqtt-packet/issues/159)
