# Packet identifier allocator comparison

Node 26.13.0 on Linux x64 in WSL2 kernel 6.18.54.1, AMD Ryzen 5 3600. The Set implementation came from source blob `76bd8aebd6a04bfc26f6d3834385edb730018dcf` and ran from the built package. The prototype uses 2,048 32-bit words and skips full words. Both use a wraparound cursor and an idempotent release per lease.

The sparse workload holds 32 identifiers. Each repetition warms up for 20,000 reserve-and-release pairs and times 200,000 pairs. The one-free workload holds 65,534 identifiers. Each repetition warms up for 32 pairs and times 500 pairs. The runner alternates variant order across five repetitions in one process. Both passed full-range exhaustion, wraparound, occupied-ID skipping and stale-release checks before timing. Their per-workload checksums matched.

| Workload | Repetition | Set elapsed ms | Bitset elapsed ms |
| --- | ---: | ---: | ---: |
| sparse | 1 | 41.580 | 13.577 |
| sparse | 2 | 17.476 | 12.448 |
| sparse | 3 | 24.276 | 9.260 |
| sparse | 4 | 22.149 | 10.864 |
| sparse | 5 | 15.786 | 20.668 |
| one-free | 1 | 484.225 | 3.161 |
| one-free | 2 | 506.940 | 3.161 |
| one-free | 3 | 481.023 | 3.030 |
| one-free | 4 | 474.350 | 3.041 |
| one-free | 5 | 473.905 | 3.026 |

The sparse medians were 22.149 ms for Set and 12.448 ms for bitset. The one-free medians were 481.023 ms and 3.041 ms. The one-free workload repeatedly scans the maximum occupied range in the Set implementation. These timings exclude client scheduling, the broker and network I/O. Heap and garbage collection were outside the measurement.

Keep the Set for the preview. A dense table costs 8 KiB per session before lease objects. Measure memory across mostly idle sessions and latency across realistic occupancy patterns before changing the allocator. Include near-exhaustion latency in that comparison.

To reproduce this run in the development workspace, build the repository and run `node work/packet-id-allocator-bench.ts` from the workspace root. The local runner and JSONL preserve the prototype, checksums, UTC times and exact readings.
