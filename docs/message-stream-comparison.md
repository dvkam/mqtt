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

This is a delivery microbenchmark. It excludes encoding, decoding, broker throughput and network latency. Callback consumption runs synchronously; queued modes add compact payload copies and promise work. Those costs are part of the comparison. Timing is informational, with no performance threshold. The Node and Chromium memory observations below supplement this comparison. GC behavior under network load remains in #18 and #54.

The packed harness runs ownership cases through the installed browser client and a scripted MQTT 5 WebSocket peer. After iterator break, stream cancellation or overflow, the same session publishes, receives SUBACK, receives PINGRESP and disconnects. Node tests also stall a stream and verify normal source completion settles an outstanding read. The packed matrix also covers direct iterator return and throw, destination failure and pipe abort. After each local stop, the installed client accepts another SUBACK and PINGRESP and completes a QoS 1 publication on PUBACK. A concurrent reader cancel and disconnect settle both promises. Cancelling after logical source close discards an admitted message that would otherwise drain. A throwing MQTT message callback retires the session and rejects pending ping and stream reads with the same Error.

Run pnpm test for the contract gate. The existing packed browser harness builds the comparison on PRs and runs it in the scheduled browser matrix. Prepare the [installed consumer](public-types.md#packed-verification), then pass a browser engine to `test/packed/browser-build.ts` for a local runtime comparison. It also reports the isolated queue module size and verifies the callback fixture does not contain the experimental queue. The queue is not added to the npm artifact.

## Decision

The [8 November measurement record](baseline/receive-validation-measurements.md) contains the individual delivery timings, queue peaks and bundled fixture sizes. The [measurement index](measurements.md) links the other workloads and their limitations.

Keep callbacks as the default. Retain this bounded queue as a comparison candidate, with an iterator and an optional Streams facade sharing admission and terminal behavior. Do not make Web Streams the transport interface or couple application cancellation to the shared reader. Keep any facade export behind the decision in #54. The allocation and batching experiment in #118 can test whether a narrower application interface earns its cost. Do not add a stream-helper dependency for this prototype.

## Session retirement

The packed browser comparison wires the optional public `onSessionEnd` observer to the experimental queue. A successful local MQTT DISCONNECT lets the queue drain before the stream finishes. Session failure clears queued work and rejects pending reads with the first session error. An earlier consumer cancellation or overflow keeps its original outcome. The queue still owns neither the protocol reader nor the socket.

The packed Chromium fixture covers a queued delivery after local disconnect and an aborted session with a pending read. The Node packed Mosquitto fixture checks that TCP, WS and WSS pass through the same cancellation Error. The facade remains experimental. The permanent facade decision stays open under #54.

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

Web Streams had the largest temporary allocation sample in this workload. Both queued modes also copy payloads and incur asynchronous bookkeeping. The sample totals alone cannot attribute the difference to individual call sites. The Chromium section below repeats allocation sampling and measures backing storage while consumers are stalled.

Run from the repository root with the pinned development runtime. Repeat five times in fresh processes, rotating the mode order across runs.

```sh
for mode in callback iterator web-stream; do
  node --expose-gc test/bench/delivery-memory.ts "$mode" allocations
  node --expose-gc test/bench/delivery-memory.ts "$mode" retained
done
```

## Chromium allocation and stalled queues

Chromium 158.0.8127.18 ran headless on WSL2. Each observation starts a fresh browser. For the allocation samples, the runner warms up and then measures one pass of 20,000 ordered 256-byte messages, using the same workload as Node. It checks the count, order, checksum and queue limits for both passes. The DevTools sampler uses a 1,024-byte interval and includes samples collected by major and minor GC. Totals include the workload and runtime bookkeeping. Compare delivery modes within this Chromium run. The Node inspector and Chromium renderer have different overhead. [DevTools HeapProfiler](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/#method-startSampling)

| Mode | Five sampled totals in bytes | Median |
| --- | --- | ---: |
| Callback | 6,530,412 · 6,469,144 · 6,691,360 · 6,507,356 · 6,519,348 | 6,519,348 |
| Async iterator | 12,690,184 · 12,681,808 · 12,627,508 · 12,689,768 · 12,671,896 | 12,681,808 |
| Web Streams | 19,671,084 · 19,840,652 · 19,818,816 · 19,969,644 · 19,949,964 | 19,840,652 |

The stalled probe runs without sampling. It creates 64 empty queues and claims each with an iterator or stream. The consumers issue zero reads. The probe admits 16 publications per queue. Each publication is a 4,096-byte view of its own 16,384-byte source buffer. The queue reports 1,024 messages and 4,196,352 accounted bytes, including 2,048 bytes for the topics.

The runner requests GC and reads isolate-wide JavaScript heap and backing storage before filling, while stalled, and after consumer cancellation. It keeps the queue handles alive throughout. Backing storage includes ArrayBuffer storage and external strings. These deltas describe the isolate in this experiment. Browser-wide memory, socket buffers and other browser engines are outside its scope. [DevTools Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage)

| Mode | Held heap delta | Five post-cancel heap deltas in bytes | Held backing delta | Post-cancel backing delta |
| --- | ---: | --- | ---: | ---: |
| Async iterator | 208,096 | 40,512 · 36,292 · 40,512 · 36,292 · 40,512 | 4,194,304 | 0 |
| Web Streams | 208,096 | 5,612 · 5,612 · 5,612 · 5,612 · 5,612 | 4,194,304 | 0 |

The held heap and both backing deltas repeat across all five runs for each mode. In a separate fault run, storing the original view raised the held backing delta to 16,777,216 bytes for each queued mode while the occupancy counters stayed the same. The compact-copy test failed on that change. Omitting cancellation cleanup left 32 messages in the two-queue unit probe. Both changes were restored.

Run the probe from the repository root with the pinned Node version and the Chromium version installed by the locked Playwright package. The runner emits 25 JSON lines and rotates mode order across five repetitions. Use a bounded command when reproducing it in WSL.

```sh
pnpm exec playwright install chromium
timeout 120s node test/bench/chromium-delivery-memory.ts
```

Callbacks remain the preview default. The Chromium samples favor callbacks for temporary allocations in this workload. Both queued modes held the same payload backing storage while stalled. The permanent facade decision in #54 can use the fixed-rate and allocation attribution experiments in #118.
