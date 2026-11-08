# Node framing measurements

Measured on 8 November 2026. Runs 1 and 2 describe the test-only prototype at commit 0fe90aebb2e8739ad21c69cf71b402368e53d4bf. Run 3 uses the promoted private decoder in the TCP integration at b7b5e3b51fe5a5efa61e60a5e8ed7c12d532e773. These are decoder measurements, not end-to-end client throughput.

## Method

Run from the repository root with the pinned development runtime:

```sh
node --expose-gc test/bench/node-framing.ts > ../node-framing-results.jsonl
node --expose-gc test/bench/node-framing.ts > ../node-framing-results-final.jsonl
node --expose-gc test/bench/node-framing.ts > ../tcp-production-framing-results.jsonl
```

Each run repeats six cases three times. The input is one 263-byte MQTT 5 QoS 0 PUBLISH carrying 256 payload bytes. Each case warms 1,000 packets and measures 5,000. Input is either contiguous or split into precomputed one-byte views; creation of those views is outside the timed loop. Every case verifies packet count and payload-length checksum.

V8 allocation sampling runs during timing, at a 1,024-byte interval, including objects collected by minor or major GC. Explicit GC runs before sampling. Throughput therefore includes profiler overhead. Sampled heap bytes are estimates for the measured loop, not exact allocation counts, external ArrayBuffer allocation, peak heap, RSS or GC pause time. Backing-buffer retention is measured separately by inspecting a retained payload view.

Compact and streaming share bounded header admission and terminal rules. The reference is the unbounded mqtt-packet parser and lacks those guards. It provides context, not an equivalent hardened alternative. The harness measures valid packets without broker, socket, application-queue or reconnect work. Candidate order is fixed; there is no performance threshold or claim of universal superiority. No tests or TLC runs were active during any measurement run.

Environment captured in the second run: Node v26.13.0, Linux x64 under WSL2, kernel 6.18.54.1-microsoft-standard-WSL2, AMD Ryzen 5 3600, 12 available logical processors. The first run used the same checkout and host; its original rows record runtime but do not contain a separate environment record.

## Run 1

| Candidate | Fragment bytes | Repetition | Packets/s | Sampled heap bytes |
| --- | ---: | ---: | ---: | ---: |
| reference | 263 | 1 | 60022 | 28858024 |
| compact | 263 | 1 | 85886 | 15343616 |
| streaming | 263 | 1 | 89629 | 15288088 |
| reference | 1 | 1 | 5020 | 300188800 |
| compact | 1 | 1 | 12611 | 142206624 |
| streaming | 1 | 1 | 4582 | 302374552 |
| reference | 263 | 2 | 154651 | 9836672 |
| compact | 263 | 2 | 90404 | 14166536 |
| streaming | 263 | 2 | 106003 | 14068720 |
| reference | 1 | 2 | 5134 | 301051648 |
| compact | 1 | 2 | 12650 | 142453968 |
| streaming | 1 | 2 | 4760 | 301601104 |
| reference | 263 | 3 | 158052 | 9696936 |
| compact | 263 | 3 | 87302 | 14397824 |
| streaming | 263 | 3 | 104634 | 13879056 |
| reference | 1 | 3 | 5030 | 300391864 |
| compact | 1 | 3 | 12794 | 142054704 |
| streaming | 1 | 3 | 4778 | 300840552 |

| Candidate | Payload bytes | Retained backing bytes | Input batch bytes |
| --- | ---: | ---: | ---: |
| reference | 256 | 20263 | 20263 |
| compact | 256 | 262 | 20263 |
| streaming | 256 | 20263 | 20263 |

## Run 2

| Candidate | Fragment bytes | Repetition | Packets/s | Sampled heap bytes |
| --- | ---: | ---: | ---: | ---: |
| reference | 263 | 1 | 57046 | 28967376 |
| compact | 263 | 1 | 78494 | 15267360 |
| streaming | 263 | 1 | 85801 | 15287720 |
| reference | 1 | 1 | 4731 | 301986256 |
| compact | 1 | 1 | 11495 | 142561768 |
| streaming | 1 | 1 | 4373 | 303111048 |
| reference | 263 | 2 | 157475 | 9678880 |
| compact | 263 | 2 | 86726 | 14471208 |
| streaming | 263 | 2 | 99101 | 14055208 |
| reference | 1 | 2 | 4963 | 300958968 |
| compact | 1 | 2 | 12326 | 142210680 |
| streaming | 1 | 2 | 4583 | 300371048 |
| reference | 263 | 3 | 158369 | 9755408 |
| compact | 263 | 3 | 85527 | 14193328 |
| streaming | 263 | 3 | 103237 | 14013912 |
| reference | 1 | 3 | 4903 | 301156448 |
| compact | 1 | 3 | 12313 | 142795200 |
| streaming | 1 | 3 | 4639 | 301009360 |

| Candidate | Payload bytes | Retained backing bytes | Input batch bytes |
| --- | ---: | ---: | ---: |
| reference | 256 | 20263 | 20263 |
| compact | 256 | 262 | 20263 |
| streaming | 256 | 20263 | 20263 |

## Reading the results

In the second run, median packets/s were 157,475 for the native reference, 85,527 for compact assembly and 99,101 for streaming with contiguous input. With one-byte fragments they were 4,903, 12,313 and 4,583 respectively. Compact was about 14% slower than streaming on contiguous input and about 2.7 times faster under one-byte fragmentation. The first run showed the same direction, with about 17% contiguous overhead relative to streaming.

The retained-view case places one publication before 10,000 PINGRESP packets in a 20,263-byte input batch. A retained 256-byte payload keeps 262 backing bytes with compact assembly, compared with 20,263 in both reference and streaming cases. This describes that view's backing storage, not total live memory or a GC measurement.

Compact allocates the admitted remainder before its body arrives; streaming can defer body storage to arriving fragments. The prototype trades that bounded upfront allocation and copy for compact payload ownership and less fragment-management work. More payload sizes, malformed-input schedules and public adapter integration are required before adoption. See the design record and #75.

Raw JSONL files remain outside the repository checkout. This document contains every throughput and retained-backing observation from all three local runs. Timing values are rounded to whole packets/s for readability; the raw local rows retain elapsed milliseconds and full precision. No results file is included in the npm artifact.

## Run 3: production decoder promotion

The current runner uses src/nodePacketDecoder.ts for compact assembly and test/experiments/streaming-node-decoder.ts for streaming. Historical runs 1 and 2 require their recorded prototype revision. This run uses the same workload, iterations, warmup and profiler settings. It excludes NodePacketInput, the portable session and native socket work. No model checks or tests competed with this measurement.
| Candidate | Fragment bytes | Repetition | Packets/s | Sampled heap bytes |
| --- | ---: | ---: | ---: | ---: |
| reference | 263 | 1 | 50095 | 29137776 |
| compact | 263 | 1 | 84392 | 15266704 |
| streaming | 263 | 1 | 87348 | 15269320 |
| reference | 1 | 1 | 4878 | 301518656 |
| compact | 1 | 1 | 11982 | 143708488 |
| streaming | 1 | 1 | 4596 | 301752360 |
| reference | 263 | 2 | 158589 | 9660904 |
| compact | 263 | 2 | 93911 | 14155760 |
| streaming | 263 | 2 | 100376 | 14009904 |
| reference | 1 | 2 | 5097 | 300877800 |
| compact | 1 | 2 | 12607 | 142969608 |
| streaming | 1 | 2 | 4634 | 300311128 |
| reference | 263 | 3 | 159693 | 9878200 |
| compact | 263 | 3 | 91798 | 14393672 |
| streaming | 263 | 3 | 98669 | 14133512 |
| reference | 1 | 3 | 5015 | 300696048 |
| compact | 1 | 3 | 12664 | 142741160 |
| streaming | 1 | 3 | 4612 | 300541776 |

| Candidate | Payload bytes | Retained backing bytes | Input batch bytes |
| --- | ---: | ---: | ---: |
| reference | 256 | 20263 | 20263 |
| compact | 256 | 262 | 20263 |
| streaming | 256 | 20263 | 20263 |

Median contiguous rates were 158,589 packets/s for the native reference, 91,798 for compact and 98,669 for streaming. With one-byte fragments they were 5,015, 12,607 and 4,612. Compact's contiguous cost relative to streaming was about 7% in this run; one-byte throughput was about 2.7 times streaming. The retained-backing results were unchanged.

The cost varies across runs, and promotion changed the candidate code paths. These observations do not isolate the cause of that variation or establish a production speedup. The captured environment remained Node v26.13.0, Linux x64, WSL2 kernel 6.18.54.1-microsoft-standard-WSL2, Ryzen 5 3600 and 12 logical processors. Broader workloads and repeated end-to-end measurements remain under #18.

The #75 measurement acceptance remains partial. These runs do not measure temporary external backing allocations or peak in-progress native fragment/item occupancy. A [separate occupancy experiment](node-framing-occupancy.md) now measures the latter for a fixed workload. The [acceptance record](../node-framing-experiment.md#remaining-measurement-acceptance) keeps temporary external storage open separately from performance thresholds. Retained backing bytes are exact view observations for this workload; they do not fill that gap.
