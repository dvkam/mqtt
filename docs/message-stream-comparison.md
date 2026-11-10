# Bounded message consumption experiment

This experiment supports #8 and #54. Callback delivery remains the preview interface. The optional iterator and Web Streams candidates live in test/experiments and are not published package exports. They compare application consumption without replacing the connection's protocol byte reader.

## Ownership and terminal behavior

One connection owns one decoder and protocol reader. The application queue accepts QoS 0 publications through the existing onMessage callback. It has no socket or session-close capability. Stopping the application consumer therefore cannot close the connection. SUBACK and PINGRESP processing continues independently.

One iterator or one Web Streams facade can claim a queue. A second claim rejects. The iterator permits one outstanding next request. The Streams facade uses highWaterMark zero, so it does not prefetch into a second internal message queue. Consumer-created read promises, tee branches, transforms and destinations remain outside this bound. A consumer can retain delivered messages indefinitely.

Normal source close drains admitted messages before ending. The first source close or failure wins. A later failure does not interrupt a drain already started by close. Consumer cancellation can still discard that drain. Cancellation, iterator return or throw, destination failure, source failure and overflow discard queued messages. Cancellation and overflow are permanent for that facade. Later publications are ignored without throwing through the protocol callback. Overflow fails reads with Application message queue capacity exceeded. Source failure retains the initiating rejection value. Failure and empty source completion settle reader.closed without requiring another read. A message already handed to a pending pull survives normal close. No queue timer or listener is created.

The experiment's caller must signal source close or failure. Its connection tests do that explicitly. Automatic coupling to remote close, reconnect attempts and public session termination is not implemented, so this prototype must not be presented as a finished public stream interface.

## Capacity accounting

Both capacities must be positive safe integers. Admission checks item count and data bytes before copying or handing a message to a waiting consumer. A single message larger than the byte budget fails even when a read is waiting. Empty payloads still consume an item slot.

Data bytes are payload byteLength plus two bytes per topic and User Property string code unit. Ordered duplicate properties are included. The queue copies payload views into compact owned buffers and copies property tuples. Mutating the source publication cannot change queued data or retain its original frame through the payload view.

This is a bound on accounted variable data, not total heap. Object and array overhead, engine string storage, decoder allocations, the current callback, delivered messages, downstream queues, WebSocket framing and browser or OS buffers are excluded. Per-packet allocation is separately bounded by maxPacketBytes. Broader packet/property counts, in-flight application work and receive bursts remain under #9, #11 and #54. The facade cannot pause network input from a browser WebSocket.

The WHATWG Streams standard defines high-water marks as backpressure thresholds and cancellation as disposal of the stream's queued chunks. The facade adds hard admission checks and keeps cancellation local to application consumption. [Streams standard](https://streams.spec.whatwg.org/)

## Comparable workload

All modes consume the same 2,000 ordered QoS 0 message objects with 256-byte payloads. The producer offers batches of sixteen and waits for each batch's consumption. The gate checks attempted and received counts, order and a sequence checksum before accepting measurements. It reports throughput, delivery p99, peak queue items and accounted data bytes.

This is a delivery microbenchmark. It excludes encoding, decoding, broker throughput and network latency. Callback consumption runs synchronously; queued modes add compact payload copies and promise work. Those costs are part of the comparison. Timing is informational, with no performance threshold. Allocation sampling, retained-heap profiles, GC behavior and slower browser workloads still need #18 and #54.

The packed harness runs ownership cases through the installed browser client and a scripted MQTT 5 WebSocket peer. After iterator break, stream cancellation or overflow, the same session publishes, receives SUBACK, receives PINGRESP and disconnects. Node tests also stall a stream and verify normal source completion settles an outstanding read. Reader cancellation, iterator return and throw, pipe cancellation, destination failure and source failure have focused regressions.

Run pnpm test for the contract gate. The existing packed browser harness builds the comparison on PRs and runs it in the scheduled browser matrix. Prepare the [installed consumer](public-types.md#packed-verification), then pass a browser engine to `test/packed/browser-build.mjs` for a local runtime comparison. It also reports the isolated queue module size and verifies the callback fixture does not contain the experimental queue. The queue is not added to the npm artifact.

## Decision

The [8 November measurement record](baseline/receive-validation-measurements.md) contains the individual delivery timings, queue peaks and bundled fixture sizes. The [measurement index](measurements.md) links the other workloads and their limitations.

Keep callbacks as the default. Retain this bounded queue as a comparison candidate, with an iterator and an optional Streams facade sharing admission and terminal behavior. Do not make Web Streams the transport interface or couple application cancellation to the shared reader. Publish a facade only after source-end coupling, allocation and retained-memory measurements, and the remaining browser contract checks in #54 are complete. Do not add a stream-helper dependency for this prototype.
