# Mixed traffic preview probe

The probe exercises the supported TCP and Node WebSocket clients with QoS 0 bursts, subscriptions, ping traffic and delayed echoes. It checks capacity rejection and continued control processing under a repeatable small-burst workload. [Every measured run](baseline/mixed-traffic-probe.md) records its counts, timings, process memory and GC observations.

## Workload

Each of 1,000 rounds starts 16 publications without awaiting their completion. The client permits eight pending publications and 4,096 pending publication bytes. The first eight attempts enter the transport. The remaining eight must reject with the capacity error. Payloads contain an eight-digit ID and 248 ASCII padding bytes. The scripted peer checks exact IDs and wire order. The receiver checks complete payloads, duplicates and missing echoes.

Each burst also starts one control operation. Every tenth round subscribes; other rounds ping. An initial subscription precedes the workload. Each round waits for send outcomes, the control response and all eight echoes before starting another round. The peer serializes echoes with a 1 ms delay. On input it pauses native reads for 1 ms when no resume timer is active. Callbacks during that pause share the timer, including WebSocket messages from one native chunk. The observer performs 20,000 fixed iterations for each echo. Checksums detect omitted observer work and wrong publication totals.

The native byte budget is 65,536 with 16,384 reserved for control admission. The peer enables TCP_NODELAY. Client adapters retain their current defaults, including the Node WebSocket library's no-delay policy. The workload does not isolate those policies. Its roughly 2 KiB bursts and round barriers do not create sustained native backpressure. Do not use its TCP/WS timing difference to select an adapter or claim a general speed advantage.

The peer is a scripted protocol fixture, not an independent broker. Mosquitto remains the independent MQTT 5 integration check. This probe covers the current supported preview, not QoS 1/2 replay or the full #11 soak acceptance criteria.

## Observation boundaries

Send and echo timestamps start at the ledger attempt, before payload construction. Send latency ends when the public publication promise settles. Echo latency starts at that same attempt and ends after fixed observer work, before the bookkeeping receive call. Observer latency includes payload validation, decoding, fixed work and bookkeeping. Control latency starts after the burst, immediately before the control API call, and ends at its public response. Percentiles use nearest rank over successful samples. Capacity rejections have counts but no success latency samples.

The probe tracks actual per-round map size and clears it after verification. The peak is 16 entries; the final count must be zero. This verifies bounded round bookkeeping. The probe retains latency arrays across rounds, so process memory includes history proportional to the number of rounds.

A temporary proxy observes client Socket.write before and after each call, selected by the peer's port. It forwards the original receiver and arguments. `nativeWriteSamples` counts observations, twice per matching write. `nativeObservedPeakBytes` is the maximum writableLength at those points. It excludes transient changes between observations, kernel buffers and allocations. The proxy belongs only to this sequential experiment and restores the native method during teardown.

Memory observations include baseline, a 10 ms sample interval, final values and fieldwise sampled peaks. They include the client, peer, instrumentation and latency history in one process. External memory includes ArrayBuffer memory. These samples do not establish a leak, allocation volume, a whole-process bound or post-GC retention.

GC durations come from PerformanceObserver entries whose start time falls within the observation window. The window includes measurement setup around the timed rounds and ends before disconnect. The forced GC calibration verifies entry collection separately. Each measured child forces GC before setup; the workload does not force collections.

## Reproduction

Use the pinned source and versions in the observation record. Build the package first so package self-resolution can locate its manifest. Then emit the probe and its runtime source dependencies into an ignored directory. Native Node execution does not remap source `.js` imports to `.ts` files.

```sh
pnpm build
pnpm exec tsc -p test/bench/tsconfig.mixed.json
node --expose-gc .type-fixtures/mixed-probe/test/bench/mixed-traffic.js gc-calibration
node .type-fixtures/mixed-probe/test/bench/mixed-traffic.js
```

The parent starts six fresh child processes, alternating TCP/WS order across three repetitions. Run sequentially without tests, builds or formal checks alongside it. The entry locates repository metadata through package self-resolution and gives child processes that directory. Results include the source commit and runtime environment.

## Review and verification

Regression tests cover exact payloads, duplicates, missing echoes, round cleanup, latency ranks, fixed observer work, native write observation, memory interval samples and cleanup failures. Seven restored-source faults each fail a targeted regression. They omit round clearing, miscalculate p99, omit payload comparison, omit observer work, erase the native peak, omit interval sampling or break cleanup after a final memory-read failure.

Review found that the first CLI could not run natively, metric setup could leave a native hook after failure, and shutdown could mask the first cause or skip peer cleanup. The corrected emitted entry and transactional observation ownership have regression coverage. Both independent reviewers use the same model. Their agreement does not provide cross-model diversity.

Production admission and lifecycle code is unchanged. The existing formal models describe that production code. They do not prove this experimental peer, measurement collector or ledger. #11 retains QoS 1/2 ordering and sustained pressure work with #10 and #18. #18 also owns broader payload sizes, slow-observer workloads and repeatable performance baselines.
