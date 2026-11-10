# Bounded message consumption experiment

This experiment supports #8 and #54. Callback delivery remains the preview interface. The optional iterator and Web Streams candidates live in test/experiments and are not published package exports. They compare application consumption without replacing the connection's protocol byte reader.

## Ownership and terminal behavior

One connection owns one decoder and protocol reader. The application queue accepts QoS 0 publications through the existing onMessage callback. It has no socket or session-close capability. Stopping the application consumer therefore cannot close the connection. SUBACK and PINGRESP processing continues independently.

One iterator or one Web Streams facade can claim a queue. A second claim rejects. The iterator permits one outstanding next request. The Streams facade uses highWaterMark zero, so it does not prefetch into a second internal message queue. Consumer-created read promises, tee branches, transforms and destinations remain outside this bound. A consumer can retain delivered messages indefinitely.

Normal source close drains admitted messages before ending. The first source close or failure wins. A later failure does not interrupt a drain already started by close. Consumer cancellation can still discard that drain. Cancellation, iterator return or throw, destination failure, source failure and overflow discard queued messages. Cancellation and overflow are permanent for that facade. Later publications are ignored without throwing through the protocol callback. Overflow fails reads with Application message queue capacity exceeded. Source failure retains the initiating rejection value. Failure and empty source completion settle reader.closed without requiring another read. A message already handed to a pending pull survives normal close. No queue timer or listener is created.

The experiment's caller can wire the public onSessionEnd observer to signal source close or failure. The queue itself has no session subscription. Reconnect remains outside this experiment.

## Capacity accounting

Both capacities must be positive safe integers. Admission checks item count and data bytes before copying or handing a message to a waiting consumer. A single message larger than the byte budget fails even when a read is waiting. Empty payloads still consume an item slot.

Data bytes are payload byteLength plus two bytes per topic and User Property string code unit. Ordered duplicate properties are included. The queue copies payload views into compact owned buffers and copies property tuples. Mutating the source publication cannot change queued data or retain its original frame through the payload view.

This is a bound on accounted variable data, not total heap. Object and array overhead, engine string storage, decoder allocations, the current callback, delivered messages, downstream queues, WebSocket framing and browser or OS buffers are excluded. Per-packet allocation is separately bounded by maxPacketBytes. Broader packet/property counts, in-flight application work and receive bursts remain under #9, #11 and #54. The facade cannot pause network input from a browser WebSocket.

The WHATWG Streams standard defines high-water marks as backpressure thresholds and cancellation as disposal of the stream's queued chunks. The facade adds hard admission checks and keeps cancellation local to application consumption. [Streams standard](https://streams.spec.whatwg.org/)

## Comparable workload

All modes consume the same 2,000 ordered QoS 0 message objects with 256-byte payloads. The producer offers batches of sixteen and waits for each batch's consumption. The gate checks attempted and received counts, order and a sequence checksum before accepting measurements. It reports throughput, delivery p99, peak queue items and accounted data bytes.

This is a delivery microbenchmark. It excludes encoding, decoding, broker throughput and network latency. Callback consumption runs synchronously; queued modes add compact payload copies and promise work. Those costs are part of the comparison. Timing is informational, with no performance threshold. The Node allocation and post-drain observations below supplement this comparison. Browser profiling, GC behavior under load and stalled-consumer retention still need #18 and #54.

The packed harness runs ownership cases through the installed browser client and a scripted MQTT 5 WebSocket peer. After iterator break, stream cancellation or overflow, the same session publishes, receives SUBACK, receives PINGRESP and disconnects. Node tests also stall a stream and verify normal source completion settles an outstanding read. Reader cancellation, iterator return and throw, pipe cancellation, destination failure and source failure have focused regressions.

Run pnpm test for the contract gate. The existing packed browser harness builds the comparison on PRs and runs it in the scheduled browser matrix. Prepare the [installed consumer](public-types.md#packed-verification), then pass a browser engine to `test/packed/browser-build.ts` for a local runtime comparison. It also reports the isolated queue module size and verifies the callback fixture does not contain the experimental queue. The queue is not added to the npm artifact.

## Decision

The [8 November measurement record](baseline/receive-validation-measurements.md) contains the individual delivery timings, queue peaks and bundled fixture sizes. The [measurement index](measurements.md) links the other workloads and their limitations.

Keep callbacks as the default. Retain this bounded queue as a comparison candidate, with an iterator and an optional Streams facade sharing admission and terminal behavior. Do not make Web Streams the transport interface or couple application cancellation to the shared reader. Publish a facade only after source-end coupling, allocation and retained-memory measurements, and the remaining browser contract checks in #54 are complete. Do not add a stream-helper dependency for this prototype.

## Session retirement

The packed browser comparison wires the optional public `onSessionEnd` observer to the experimental queue. A successful local MQTT DISCONNECT lets the queue drain before the stream finishes. Session failure clears queued work and rejects pending reads with the first session error. An earlier consumer cancellation or overflow keeps its original outcome. The queue still owns neither the protocol reader nor the socket.

The packed Chromium fixture covers a queued delivery after local disconnect and an aborted session with a pending read. The Node packed Mosquitto fixture checks that TCP, WS and WSS pass through the same cancellation Error. The facade remains experimental. The permanent API decision and allocation and retained-memory comparisons stay open under #54 and #18.

## Node allocation and post-drain memory

These observations use Node 26.13.0 on WSL2. Every process warms up with 20,000 ordered QoS 0 messages of 256 bytes, then checks counts, checksum, order and queue bounds in each measured pass. Five fresh processes per mode rotate the mode order.

The allocation run samples one 20,000-message pass with the V8 inspector at a 1,024-byte interval. It includes sampled objects collected by major and minor GC. The observed totals include producer, latency bookkeeping, queue and inspector activity. They are sampled JavaScript allocation bytes. Native and ArrayBuffer backing allocations are outside that measure.

| Mode | Five sampled totals in bytes | Median |
| --- | --- | ---: |
| Callback | 12,527,464 · 12,546,232 · 12,337,512 · 12,595,272 · 12,641,608 | 12,546,232 |
| Async iterator | 27,383,584 · 27,441,776 · 27,392,608 · 27,589,296 · 29,382,776 | 27,441,776 |
| Web Streams | 49,283,024 · 49,262,320 · 49,765,152 · 49,362,192 · 49,070,128 | 49,283,024 |

The post-drain run uses a separate process without sampling. It waits one event-loop turn and requests GC before and after five measured passes. The table reports process-wide deltas after all queues drain. Runtime caches and measurement overhead can remain. This experiment does not measure live stalled queues, process resident memory or browser retention.

| Mode | Five heap used deltas in bytes | Median | ArrayBuffer deltas |
| --- | --- | ---: | --- |
| Callback | 24,752 · 24,752 · 24,752 · 24,752 · 24,752 | 24,752 | All zero |
| Async iterator | 27,544 · 27,544 · 32,144 · 32,144 · 32,144 | 32,144 | All zero |
| Web Streams | 34,392 · 33,912 · 33,824 · 33,824 · 33,912 | 33,912 | All zero |

Web Streams had the largest temporary allocation sample in this workload. Both queued modes also copy payloads and incur asynchronous bookkeeping. The sample totals alone cannot attribute the difference to individual call sites. Keep callbacks as the default while #54 compares browser and stalled-consumer workloads.

Run from the repository root with the pinned development runtime. Repeat five times in fresh processes, rotating the mode order across runs.

```sh
for mode in callback iterator web-stream; do
  node --expose-gc test/bench/delivery-memory.ts "$mode" allocations
  node --expose-gc test/bench/delivery-memory.ts "$mode" retained
done
```
