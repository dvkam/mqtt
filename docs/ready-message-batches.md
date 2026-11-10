# Ready message batches

This #118 experiment adds a batch iterator to the test-only application queue. It uses the same consumer claim and compact per-message payload copies as the single-message iterator. The preview client still exposes callback delivery.

The batch waits for its first item, then takes the ready FIFO prefix in one synchronous step. It stops at the selected item count or the queue's byte cap, including the first item in both limits. It returns a partial batch immediately and leaves an item that cannot fit at the head for the next read. It starts no timer and adds no intentional wait to fill a batch.

The first item is staged until the batch is assembled. The queue occupancy excludes this one staged item, as it excludes the single-message iterator's handoff. The waiting queue and the returned batch each have their own byte bound. The code discards the staged item if consumer cancellation wins before assembly. A source failure in that gap rejects with the original cause. Graceful source close preserves staged and ready work. One batch read owns assembly at a time. Reusing or transferring one delivered payload leaves every other payload independent.

## Comparison method

The [fixed-rate runner](fixed-rate-delivery-allocation.md) compares the existing single-message iterator with ready batches capped at 1, 4 and 16 items. All paths consume every message and validate sequence and checksum. The runner also validates the observed dispatch and batch-size counts. Batch size 1 is a control for the extra staging and result array. The single-message comparison is measured from the same checkout as the batch modes.

Each mode uses the same shallow and deep burst schedule and 256-byte payload. The runner reports V8 sampled JavaScript allocations and a separate unprofiled timing pass. Batch age measures the first message's age at delivery. The shallow and deep schedules have different counts. Compare modes within a schedule and runtime. This probe excludes network control latency, native memory and persistent queue backlog between bursts.

## Results

Five fresh runs per combination on WSL2 used Node 26.13.0 or Chromium 158.0.8127.18. The allocation column lists each sampled total. Dispatches and p99 oldest age are medians from the five unprofiled passes.

| Runtime | Workload | Mode | Five sampled totals in bytes | Median bytes | Dispatches | p99 oldest age ms |
| --- | --- | --- | --- | ---: | ---: | ---: |
| Node | Shallow | Iterator | 3,586,656 · 3,589,536 · 3,588,352 · 3,544,400 · 3,637,016 | 3,588,352 | 2,048 | 0.10 |
| Node | Shallow | Batch 1 | 5,613,496 · 5,592,280 · 5,584,088 · 5,571,560 · 5,568,368 | 5,584,088 | 2,048 | 0.09 |
| Node | Shallow | Batch 4 | 3,886,768 · 3,756,520 · 3,779,232 · 3,776,656 · 3,816,824 | 3,779,232 | 512 | 0.09 |
| Node | Shallow | Batch 16 | 3,257,928 · 3,233,160 · 3,187,768 · 3,291,008 · 3,233,960 | 3,233,960 | 128 | 0.14 |
| Node | Deep | Iterator | 6,709,840 · 6,600,944 · 6,655,456 · 6,703,592 · 6,627,968 | 6,655,456 | 4,096 | 0.32 |
| Node | Deep | Batch 1 | 9,900,208 · 9,823,368 · 9,965,672 · 9,917,096 · 10,488,336 | 9,917,096 | 4,096 | 0.31 |
| Node | Deep | Batch 4 | 6,284,400 · 7,025,128 · 6,918,704 · 6,843,288 · 6,913,728 | 6,913,728 | 1,024 | 0.22 |
| Node | Deep | Batch 16 | 5,787,832 · 5,898,960 · 5,927,984 · 5,960,352 · 5,860,624 | 5,898,960 | 256 | 0.28 |
| Chromium | Shallow | Iterator | 1,386,492 · 1,566,724 · 1,463,676 · 1,445,468 · 1,465,360 | 1,463,676 | 2,048 | 0.20 |
| Chromium | Shallow | Batch 1 | 2,376,288 · 2,299,628 · 2,258,068 · 2,329,864 · 2,309,904 | 2,309,904 | 2,048 | 0.20 |
| Chromium | Shallow | Batch 4 | 1,651,940 · 1,659,036 · 1,617,552 · 1,685,676 · 1,717,288 | 1,659,036 | 512 | 0.20 |
| Chromium | Shallow | Batch 16 | 1,454,652 · 1,413,156 · 1,426,280 · 1,455,340 · 1,378,948 | 1,426,280 | 128 | 0.20 |
| Chromium | Deep | Iterator | 2,662,088 · 2,895,172 · 2,714,224 · 2,691,848 · 2,776,652 | 2,714,224 | 4,096 | 0.30 |
| Chromium | Deep | Batch 1 | 4,367,852 · 4,428,880 · 4,339,412 · 4,404,140 · 4,380,440 | 4,380,440 | 4,096 | 0.30 |
| Chromium | Deep | Batch 4 | 3,350,660 · 3,220,612 · 3,155,420 · 3,231,360 · 3,149,568 | 3,220,612 | 1,024 | 0.30 |
| Chromium | Deep | Batch 16 | 2,649,432 · 2,668,260 · 2,612,292 · 2,670,184 · 2,708,752 | 2,668,260 | 256 | 0.30 |

Batch 16 reduced dispatches from 2,048 to 128 on shallow bursts and from 4,096 to 256 on deep bursts. Its median sampled allocations were 9.9% lower on shallow Node bursts and 11.4% lower on deep Node bursts. Chromium medians were 2.6% lower and 1.7% lower. Batch 1 and batch 4 increased median allocations in these runs. Chromium differences were small relative to the observed variation. Keep the prototype for network experiments and keep callbacks as the preview interface.

The isolated experimental queue bundle grew from 3,114 to 4,224 minified bytes and from 1,276 to 1,518 gzip bytes. The packed callback fixture stayed at 21,270 minified bytes. Its graph check still excludes the experimental queue.

## Reproduction

Run the fixed-rate profiler with the additional batch modes. Rotate iterator, batch-1, batch-4 and batch-16 order across five repetitions and alternate workload order.

```sh
timeout 60s node test/bench/fixed-rate-allocations.ts node shallow batch-4
timeout 60s node test/bench/fixed-rate-allocations.ts chromium deep batch-16
```
