# Fixed-rate message delivery allocations

This experiment starts #118. It compares the existing callback, iterator and Web Streams paths under bursts scheduled independently of consumption. It measures the local delivery loop. It excludes MQTT encoding, transport, rendering and sustained broker pressure.

| Workload | Bursts | Messages per burst | Period | Offered | Queue item limit | Queue byte limit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Shallow | 128 | 16 | 8 ms | 2,048 | 16 | 4,128 |
| Deep | 32 | 128 | 12 ms | 4,096 | 128 | 33,024 |

Every publication has a 256-byte payload and the one-character topic `a`. The first four bytes carry its sequence. Each burst targets the start time plus its period times the burst index. The producer waits for that target and offers the full burst without awaiting the consumer. If a timer runs late, the next target remains fixed and the producer still yields before the next burst. The probe records observed schedule lateness.

Every fresh process or browser does one warmup, one unprofiled timing pass and one allocation pass. The runner checks count, sequence order, checksum, peak capacity, zero pending items and zero pending bytes before accepting an observation. A separate overflow test confirms that the producer still offers all scheduled bursts. Its loss excludes it from the allocation comparison. A dropped message in the real callback path also fails the gate.

The inspector samples JavaScript allocations at a 1,024-byte interval and includes objects collected by major or minor GC. Sample totals include producer and measurement bookkeeping. ArrayBuffer backing storage is measured separately in the [stalled-queue probe](message-stream-comparison.md#chromium-allocation-and-stalled-queues). The leading stack frames identify candidates for experiments. They do not isolate the cost of the named function from allocations it initiates. Chromium stack lines refer to the generated test bundle.

The timing pass runs without the sampler. Schedule delay is actual burst start minus its target. Queue age is the time from an offer to application delivery, including local dispatch. The p99 age describes delivered messages. The test yields between bursts and uses a synchronous consumer, so the results do not establish oldest live backlog, MQTT control latency or browser responsiveness under network load.

## Results

Node 26.13.0 and Chromium 158.0.8127.18 ran on the same WSL2 host. The allocation column lists all five sampled totals in repetition order. Delay and age columns give the median of the five unprofiled p99 values, with the observed minimum and maximum in parentheses. Compare modes within a runtime and workload. The shallow and deep schedules offer different counts and rates.

| Runtime | Workload | Delivery | Five sampled totals in bytes | Median bytes | Schedule delay ms | Queue age ms |
| --- | --- | --- | --- | ---: | ---: | ---: |
| Node | Shallow | Callback | 2,024,704 · 1,854,312 · 1,975,400 · 1,915,032 · 1,944,384 | 1,944,384 | 7.73 (1.18 to 14.28) | 0.00 (0.00 to 0.01) |
| Node | Shallow | Iterator | 3,539,984 · 3,742,208 · 3,741,296 · 3,609,968 · 3,665,416 | 3,665,416 | 5.01 (1.07 to 15.62) | 0.55 (0.11 to 3.09) |
| Node | Shallow | Web Streams | 5,867,680 · 5,799,920 · 5,705,664 · 5,715,120 · 5,866,688 | 5,799,920 | 8.36 (1.19 to 13.02) | 0.85 (0.09 to 2.24) |
| Node | Deep | Callback | 3,356,760 · 3,371,216 · 3,453,464 · 3,368,560 · 3,339,704 | 3,368,560 | 6.50 (1.07 to 12.01) | 0.00 (0.00 to 0.00) |
| Node | Deep | Iterator | 6,805,432 · 6,595,864 · 6,194,952 · 6,206,656 · 6,642,952 | 6,595,864 | 5.25 (1.07 to 25.93) | 0.77 (0.34 to 33.17) |
| Node | Deep | Web Streams | 10,185,392 · 10,311,592 · 10,199,608 · 10,956,600 · 10,290,688 | 10,290,688 | 9.91 (1.35 to 23.50) | 8.99 (0.44 to 11.87) |
| Chromium | Shallow | Callback | 684,104 · 773,828 · 780,300 · 746,232 · 781,248 | 773,828 | 7.50 (1.10 to 34.00) | 0.00 (0.00 to 0.10) |
| Chromium | Shallow | Iterator | 1,419,540 · 1,434,980 · 1,547,628 · 1,483,956 · 1,476,924 | 1,476,924 | 5.90 (1.10 to 11.30) | 0.20 (0.20 to 0.40) |
| Chromium | Shallow | Web Streams | 2,113,456 · 2,177,744 · 2,256,932 · 2,185,676 · 2,125,632 | 2,177,744 | 6.70 (5.50 to 7.30) | 0.40 (0.30 to 5.80) |
| Chromium | Deep | Callback | 1,377,140 · 1,290,412 · 1,290,052 · 1,386,064 · 1,296,392 | 1,296,392 | 5.70 (1.30 to 20.80) | 0.00 (0.00 to 0.00) |
| Chromium | Deep | Iterator | 2,792,412 · 2,649,884 · 2,806,088 · 2,758,300 · 2,728,136 | 2,758,300 | 1.80 (1.00 to 9.30) | 1.50 (0.30 to 5.90) |
| Chromium | Deep | Web Streams | 4,041,684 · 3,933,916 · 4,087,092 · 4,218,624 · 4,175,208 | 4,087,092 | 5.60 (1.10 to 23.90) | 1.50 (0.50 to 21.80) |

Callbacks had the lowest sampled allocation total in both workloads and runtimes. Queue push and typed-array work appeared in queued profiles. Node also surfaced iterator next and native promise bookkeeping. Web Streams pull appeared in both runtimes. None of the leading five stacks across the 60 runs named array shift. This is evidence to test batched dispatch first. It leaves the storage decision open until a workload shows a material storage cost.

## Reproduction

Run from the repository root with the pinned Node and Playwright Chromium versions. The arguments select the runtime, workload and delivery mode.

```sh
pnpm exec playwright install chromium
timeout 60s node test/bench/fixed-rate-allocations.ts node shallow iterator
timeout 60s node test/bench/fixed-rate-allocations.ts chromium deep web-stream
```

Use five fresh runs per combination. Rotate callback, iterator and Web Streams order on each repetition, and alternate shallow-first and deep-first. Each run emits one JSON observation with unprofiled timing, profiled counts, sampled allocation totals and the twelve leading stacks.
