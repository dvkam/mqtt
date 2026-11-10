# PUBLISH encoding allocation and throughput

The comparison used Node 26.13.0 and Chromium 158.0.8127.18 on WSL2 x64 with an AMD Ryzen 5 3600. The baseline is the portable codec at `4194394`. The Node comparison also uses pinned mqtt-packet 9.0.2 for workloads that produce the same bytes. The interleaved User Properties workload compares the two portable implementations because the retained parser package uses grouped properties.

The candidate computes Remaining Length from the already encoded fields and copies those fields into the final frame. It removes the intermediate PUBLISH body buffer and copies the payload once. Topic and property encoders still allocate temporary arrays. The join cursor advances by the length of each copied field, and the fixed vectors test the 127, 128 and 16,384 Remaining Length boundaries. They also verify that changing the original payload view cannot affect the returned bytes. The QoS 1 and decoder suites cover the remaining identifier, flags, fragmentation and malformed-input cases.

## Unprofiled elapsed time

Each encoder warmed up for 2,000 calls per workload. The run alternated comparison order and took three samples. The table shows the median and range in milliseconds for the call count shown. The runner checks exact Node wire parity before timing and checks the encoded-byte totals in both runtimes.

| Workload | Calls | Node before | Node after | Node mqtt-packet | Chromium before | Chromium after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ascii-0 | 100,000 | 156.3 (141.9 to 174.5) | 154.6 (153.6 to 164.5) | 114.2 (106.2 to 117.0) | 223.3 (186.2 to 247.1) | 217.8 (180.7 to 219.3) |
| ascii-16 | 100,000 | 158.3 (155.8 to 160.0) | 161.4 (156.4 to 168.4) | 118.0 (106.3 to 121.7) | 188.7 (188.0 to 196.3) | 184.1 (182.1 to 184.3) |
| ascii-256 | 100,000 | 613.9 (570.3 to 737.6) | 463.0 (275.8 to 543.5) | 107.1 (103.0 to 111.9) | 350.9 (317.5 to 365.9) | 281.4 (261.5 to 290.5) |
| ascii-4096 | 16,384 | 129.3 (75.1 to 168.2) | 78.4 (49.0 to 89.0) | 39.6 (36.5 to 45.0) | 174.9 (170.9 to 204.1) | 132.3 (109.5 to 141.8) |
| ascii-65536 | 2,000 | 51.3 (50.6 to 52.2) | 26.7 (26.2 to 27.2) | 25.5 (25.2 to 25.5) | 251.7 (251.5 to 252.6) | 128.4 (127.4 to 128.4) |
| unicode-256 | 100,000 | 598.1 (463.3 to 795.3) | 477.9 (262.3 to 558.5) | 128.0 (120.2 to 132.3) | 391.8 (337.3 to 458.0) | 292.4 (281.7 to 328.1) |
| properties-256 | 100,000 | 2853.2 (2350.4 to 2912.1) | 2450.1 (2409.9 to 2501.5) | Outside matched workload | 1882.3 (1811.8 to 1884.3) | 1706.2 (1616.5 to 1813.9) |

The largest repeatable improvement is the 64 KiB case. The smallest cases are close. The first exploratory Chromium run also saw the property-heavy case move from 1,620.1 to 1,704.2 ms. The checked-in runner measured it in the other direction. Treat that workload as variable until a longer independent run separates the difference from timing noise.

## Allocation sampling

V8 sampled at 1,024-byte intervals and included objects collected by major and minor GC. The table gives median sampled bytes from three runs. These samples describe reported allocation stacks. They do not measure ArrayBuffer backing stores, peak process memory or retained heap.

| Workload | Calls | Portable before | Portable after | mqtt-packet |
| --- | ---: | ---: | ---: | ---: |
| ascii-256 | 10,000 | 29,444,736 | 29,560,808 | 23,390,176 |
| ascii-65536 | 2,000 | 5,926,136 | 5,876,528 | 5,273,504 |
| properties-256 | 10,000 | 80,848,864 | 81,418,736 | Outside matched workload |

In the first 256-byte baseline sample, the largest visible groups were encodePacket itself at 8.09 MB, properties at 6.36 MB, and utf8 at 5.23 MB. The first property-heavy baseline sample attributed 30.18 MB to the properties-to-utf8 stack and 13.53 MB to its Uint8Array.of stack. V8 can inline joins, so those groups cannot assign all costs to a specific copy. The measured sampled totals stayed close despite removing one frame-sized backing store.

A separate Node field experiment compared TextEncoder.encode followed by a length-prefixed copy with counting UTF-8 bytes in JavaScript followed by encodeInto. After 2,000 warmup calls, three 100,000-call samples gave the following medians in milliseconds. The two methods produced equal bytes for each valid string.

| Input | Encode and copy | Count and encodeInto |
| --- | ---: | ---: |
| short-ascii | 54.8 | 72.0 |
| unicode | 70.0 | 70.9 |
| long-property | 496.1 | 680.7 |

The field experiment used `bench/topic`, `bench/é/😀/` followed by U+FEFF, and 128 repeats of `π😀`. Keep the existing field encoder. An encodeInto design would need a sizing strategy with evidence that it pays for the extra scan.

## Bundle and reproduction

The isolated minified Vite ESM codec measured 13,191 bytes before and 13,182 after. Gzip measured 3,938 and 3,956 bytes. This comparison excludes the rest of the client, test runner, and Node transport dependencies. The packed CI job separately checks the installed consumer.

Build the baseline and save its compiled `dist` directory. Build the candidate, then run `node test/bench/encode-compare.ts <baseline-dist>/codec.js` for Node timing and allocation stacks. Pass `--browser` for the Chromium timing and bundle results. Install the pinned Playwright browser first. The runner prints JSONL. Keep the run files with local or CI artifacts.

Keep the single frame assembly for PUBLISH. The measured gain comes with a small source change and unchanged wire bytes. Keep the property and string encoding work separate. This run sets no performance threshold and makes no parser replacement decision. Refs #56, #37 and #18.
