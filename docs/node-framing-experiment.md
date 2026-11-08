# Bounded Node decoding experiment

The compact candidate is now the private decoder behind [supported TCP packet admission](tcp-packet-input.md). Streaming remains an experimental comparator. No storage-policy option or decoder entry point is published. WS/WSS integration and the remaining protocol-capacity work stay open under [#75](https://github.com/dvkam/mqtt/issues/75) and #9.

## What the experiment preserves

The pinned mqtt-packet 9.0.2 parser reports invalid CONNACK flags from byte 0x21 alone and invalid QoS from byte 0x36 alone. A fourth Remaining Length continuation fails without a body. It accepts a nonminimal zero encoded as 0x80, 0x00. Some reserved-command errors wait for the body. Tests retain these distinctions rather than importing the portable codec's narrower allowlist.

The wrapper forwards a compact copy of the first byte to the retained parser. It collects at most four length bytes and validates total wire size, including the actual encoded header, before admitting the body. A malformed fourth continuation is passed to the retained parser for its native error. Native error events and thrown callbacks become permanent wrapper failures.

Both candidates preserve completed-packet callbacks before a later packet in the same input fails. This differs from the portable decoder's returned-batch interface. The fixed corpus covers content type, QoS 1, maximum packet size, AUTH, reasoned DISCONNECT, UNSUBACK and PUBACK across every input split. It is a compatibility sample, not complete protocol conformance or public support for those operations.

## Storage candidates

Compact assembly allocates an unpooled remainder buffer after size admission. It includes Remaining Length and body, excluding the already consumed first byte. All bytes are filled before native payload decoding. Delivered Buffer payloads keep this compact storage, remain mutable and do not alias caller input. A declared but unfinished admitted packet can reserve its full capacity before its body arrives.

The streaming gate forwards admitted body fragments to the retained parser. It avoids that upfront body copy, but the parser retains fragment metadata and may retain larger input backing buffers through payload views. It can copy when a field spans fragments. The comparison candidates share size validation and failure rules; the unbounded native parser is a separate reference.

Both candidates detach the retained parser and clear assembly references after failure or stop. Partial remote EOF fails; an established failure or stop reason takes precedence. Successful finish is idempotent and rejects later input. Callback retirement is checked before push returns, including zero-body packets and the last packet in an input. Reentrant push or finish fails permanently. Input callbacks are synchronous and byte views are ordinary, attached views.

The budget covers declared packet bytes and owned assembly, not decoded objects, retained output, native socket buffers, total heap, process memory or application queues. Compact payload ownership does not prevent a consumer from retaining every delivered packet.

## Measurements and recommendation

All observations, workload details, environment and reproduction commands are in [the measurement record](baseline/node-framing-measurements.md). Raw profiler JSONL remains local. The measured tradeoff favors compact ownership under high fragmentation while adding cost to contiguous input. Heap samples omit external ArrayBuffer allocation and are not peak-memory measurements.

TCP now uses compact assembly, with public and packed tests for limits, pending acknowledgments, callback abort, EOF and Buffer ownership. The current benchmark and characterization suite use that production decoder directly for compact cases. Keep streaming as an experimental comparator. WS/WSS still needs the same integration evidence. Extend workloads beyond the measured 256-byte payload before setting performance thresholds. #75 remains open for that work and the final adoption decision.

The checked upstream commit dd17095bbe52ac28bc96c831e69b0db4371da5a5 identifies itself as 9.0.2. Its v10 roadmap describes a separate transport-independent codec and a compatibility wrapper. This experiment retains the current decoder and does not claim a comparison with v10. [Pinned upstream package](https://github.com/mqttjs/mqtt-packet/blob/dd17095bbe52ac28bc96c831e69b0db4371da5a5/package.json) · [v10 roadmap](https://github.com/mqttjs/mqtt-packet/issues/159)

## Verification

Run `pnpm test test/bounded-node-decoder.test.ts`. The first passthrough run failed 19 of 28 tests; the streaming-copy regression also failed before the alternative was added. The expanded suite includes limits, early errors, wire compatibility, compact backing ownership, cancellation, EOF, reentrancy and failure identity.

NodePacketAdmission models both policies with a three-unit total-wire bound, two decode attempts and a fixed two-unit header abstraction. It now maps compact behavior to the private production decoder and streaming behavior to the experimental module. It checks admission before body storage, complete input before payload decoding, permanent failure, retirement and truncated EOF. Native header interpretation, byte contents, backing-buffer ownership, Error identity, parser detachment, reentrant calls and physical connection closure remain concrete-test and review responsibilities. NodeInputLifecycle covers the TCP composition separately.
