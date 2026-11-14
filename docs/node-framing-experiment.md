# Bounded Node decoding experiment

Update, 13 November 2026: the supported decoder now parses each compact frame with the portable codec. The observations below describe the framer that handed frames to mqtt-packet. `test/experiments/mqtt-packet-compact-decoder.ts` keeps that framer for this comparison.

The compact candidate is now the private decoder behind [supported TCP packet admission](tcp-packet-input.md) and [Node WS/WSS input](websocket-packet-input.md). Streaming remains an experimental comparator. No storage-policy option or decoder entry point is published. Broader malformed-packet rules and property limits remain under #9; the admission comparison and adoption decision are tracked in [#75](https://github.com/dvkam/mqtt/issues/75).

## What the experiment preserves

The pinned mqtt-packet 9.0.2 parser reports invalid CONNACK flags from byte 0x21 alone and invalid QoS from byte 0x36 alone. A fourth Remaining Length continuation fails without a body. It accepts a nonminimal zero encoded as 0x80, 0x00. Some reserved-command errors wait for the body. The compact production framer now rejects the nonminimal length before allocation. This deliberate difference leaves the retained parser and streaming experiment available as comparison controls.

Source inspection found no supported pre-allocation packet cap in the installed 9.0.2 parser. Its parse method appends incoming bytes to BufferList before advancing header, length and payload states. A configured protocolVersion selects interpretation; it does not impose the wrapper's admission budget. The inspected [upstream parser](https://github.com/mqttjs/mqtt-packet/blob/dd17095bbe52ac28bc96c831e69b0db4371da5a5/parser.js) has the same append-before-parse structure.

That upstream commit still declares version 9.0.2 but is not byte-identical to the installed published package. Its parser also changes omitted AUTH reason handling and repeated user-property handling when an earlier value is empty. The [fixed-wire comparison](codec-comparison.md) now records both cases. The measurements and compatibility corpus use the installed package, not an unrecorded replacement with upstream master.

The wrapper forwards a compact copy of the first byte to the retained parser. It collects at most four length bytes and validates total wire size, including the actual encoded header, before admitting the body. A malformed fourth continuation is passed to the retained parser for its native error. Native error events and thrown callbacks become permanent wrapper failures.

Both candidates preserve completed-packet callbacks before a later packet in the same input fails. This differs from the portable decoder's returned-batch interface. The fixed corpus covers content type, QoS 1, maximum packet size, AUTH, reasoned DISCONNECT, UNSUBACK and PUBACK across every input split. It is a compatibility sample, not complete protocol conformance or public support for those operations.

## Storage candidates

Compact assembly allocates an unpooled remainder buffer after size admission. It includes Remaining Length and body, excluding the already consumed first byte. All bytes are filled before native payload decoding. Delivered Buffer payloads keep this compact storage, remain mutable and do not alias caller input. A declared but unfinished admitted packet can reserve its full capacity before its body arrives.

The streaming gate forwards admitted body fragments to the retained parser. It avoids that upfront body copy, but the parser retains fragment metadata and may retain larger input backing buffers through payload views. It can copy when a field spans fragments. The comparison candidates share size validation and failure rules; the unbounded native parser is a separate reference.

Both candidates detach the retained parser and clear assembly references after failure or stop. Partial remote EOF fails; an established failure or stop reason takes precedence. Successful finish is idempotent and rejects later input. Callback retirement is checked before push returns, including zero-body packets and the last packet in an input. Reentrant push or finish fails permanently. Input callbacks are synchronous and byte views are ordinary, attached views.

The budget covers declared packet bytes and owned assembly, not decoded objects, retained output, native socket buffers, total heap, process memory or application queues. Compact payload ownership does not prevent a consumer from retaining every delivered packet.

## Measurements and recommendation

All observations, workload details, environment and reproduction commands are in [the measurement record](baseline/node-framing-measurements.md). Raw profiler JSONL remains local. The measured tradeoff favors compact ownership under high fragmentation while adding cost to contiguous input. Heap samples omit external ArrayBuffer allocation and are not peak-memory measurements.

TCP and Node WS/WSS now use compact assembly, with public and packed tests for limits, pending acknowledgments, callback abort, EOF and Buffer ownership. The current benchmark and characterization suite use that production decoder directly for compact cases. Keep streaming as an experimental comparator. Extend workloads beyond the measured 256-byte payload before setting performance thresholds under #18. This adoption preserves the sampled Node profile rather than replacing it with the portable codec's narrower profile.

The checked upstream commit dd17095bbe52ac28bc96c831e69b0db4371da5a5 identifies itself as 9.0.2. Its v10 roadmap describes a separate transport-independent codec and a compatibility wrapper. This experiment retains the current decoder and does not claim a comparison with v10. [Pinned upstream package](https://github.com/mqttjs/mqtt-packet/blob/dd17095bbe52ac28bc96c831e69b0db4371da5a5/package.json) · [v10 roadmap](https://github.com/mqttjs/mqtt-packet/issues/159)

## Verification

Run `pnpm test test/bounded-node-decoder.test.ts`. The first passthrough run failed 19 of 28 tests; the streaming-copy regression also failed before the alternative was added. The expanded suite includes limits, early errors, wire compatibility, compact backing ownership, cancellation, EOF, reentrancy and failure identity.

NodePacketAdmission models both policies with a three-unit total-wire bound, two decode attempts and a fixed two-unit header abstraction. It now maps compact behavior to the private production decoder and streaming behavior to the experimental module. It checks admission before body storage, complete input before payload decoding, permanent failure, retirement and truncated EOF. Native header interpretation, byte contents, backing-buffer ownership, Error identity, parser detachment, reentrant calls and physical connection closure remain concrete-test and review responsibilities. NodeInputLifecycle covers the TCP composition separately.

## Remaining measurement acceptance

The public integration and admission decision do not complete every measurement requested in #75. Keep that issue open for the following accounting work.

| Requested evidence | Current record | Status |
| --- | --- | --- |
| Temporary allocations | Sampled V8 heap bytes in all three runs; temporary external ArrayBuffer allocation is excluded | Partial |
| Retained payload storage | Exact backing size for the 256-byte retained payload in every run | Measured for this workload |
| In-progress occupancy | [Eight instrumented observations](baseline/node-framing-occupancy.md) count native bytes/items and compact assembly capacity for contiguous, one-byte and partial input | Measured for this workload |
| Browser graph impact | Packed raw/gzip fixture observations before and after both integrations | Measured for these fixtures |

No application queue was added by the input helper. That fact does not substitute for measuring parser fragments or temporary external storage. The occupancy experiment compares compact and streaming under the same admitted packet profile, including partial and highly fragmented packets. It does not measure temporary external storage. Keep the native unbounded parser as contextual evidence. Record logical byte/item accounting separately from process memory, and preserve instrumentation overhead and GC limits. Broader performance thresholds remain #18; temporary external-allocation measurement remains #75.
