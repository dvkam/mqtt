# PUBLISH encoding allocation and throughput

The comparison used Node 26.13.0 and Chromium 158.0.8127.18 on WSL2 x64 with an AMD Ryzen 5 3600. The baseline is the portable codec at `4194394`. The Node comparison also uses pinned mqtt-packet 9.0.2 for workloads that produce the same bytes. The interleaved User Properties workload compares the two portable implementations because the retained parser package uses grouped properties.

The candidate computes Remaining Length from the already encoded fields and copies those fields into the final frame. It removes the intermediate PUBLISH body buffer and copies the payload once. Topic and property encoders still allocate temporary arrays. The copy cursor advances by the length of each copied field, and the fixed vectors test the 127, 128 and 16,384 Remaining Length boundaries. They also verify that changing the original payload view cannot affect the returned bytes. A growing input that no longer fits the captured frame size raises RangeError. The QoS 1 and decoder suites cover the remaining identifier, flags, fragmentation and malformed-input cases.

## Unprofiled elapsed time

The workloads use QoS 0. Each encoder warmed up for 2,000 calls per workload. The run alternated comparison order and took three samples. The table shows the median and range in milliseconds for the call count shown. The runner checks exact Node wire parity before timing and checks the encoded-byte totals in both runtimes.

| Workload | Calls | Node before | Node after | Node mqtt-packet | Chromium before | Chromium after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ascii-0 | 100,000 | 179.1 (166.9 to 179.9) | 168.4 (163.3 to 181.6) | 118.4 (117.3 to 119.8) | 224.7 (193.9 to 241.7) | 210.9 (185.6 to 218.9) |
| ascii-16 | 100,000 | 152.7 (148.2 to 155.9) | 136.0 (132.3 to 145.8) | 119.6 (107.9 to 121.1) | 205.6 (203.8 to 215.2) | 189.9 (189.3 to 197.5) |
| ascii-256 | 100,000 | 476.8 (403.7 to 480.2) | 336.2 (259.7 to 384.7) | 120.3 (112.6 to 139.4) | 398.9 (352.2 to 417.6) | 302.5 (253.9 to 331.9) |
| ascii-4096 | 16,384 | 114.1 (89.5 to 135.0) | 78.0 (63.9 to 88.1) | 44.9 (33.3 to 48.0) | 240.0 (159.6 to 259.8) | 126.3 (125.4 to 131.2) |
| ascii-65536 | 2,000 | 57.4 (54.8 to 65.8) | 27.5 (24.4 to 28.1) | 26.3 (25.5 to 26.7) | 258.2 (258.1 to 265.0) | 128.8 (125.8 to 130.8) |
| unicode-256 | 100,000 | 577.5 (470.0 to 777.8) | 470.4 (244.6 to 474.0) | 121.4 (112.6 to 128.0) | 436.3 (393.2 to 492.6) | 327.8 (279.8 to 357.9) |
| properties-256 | 100,000 | 2853.1 (2392.0 to 2947.2) | 2613.9 (2553.3 to 2671.8) | Outside matched workload | 1698.2 (1670.4 to 1926.6) | 1738.3 (1524.4 to 1817.2) |

The largest repeatable improvement is the 64 KiB case. The smallest cases are close. The first exploratory Chromium run also saw the property-heavy case move from 1,620.1 to 1,704.2 ms. The runs with the checked-in runner varied. Treat that workload as variable until a longer independent run separates the difference from timing noise.

## Allocation sampling

V8 sampled at 1,024-byte intervals and included objects collected by major and minor GC. The table gives median sampled bytes from three runs. These samples describe reported allocation stacks. They do not measure ArrayBuffer backing stores, peak process memory or retained heap.

| Workload | Calls | Portable before | Portable after | mqtt-packet |
| --- | ---: | ---: | ---: | ---: |
| ascii-256 | 10,000 | 29,545,528 | 26,886,000 | 23,203,344 |
| ascii-65536 | 2,000 | 5,874,400 | 5,457,672 | 5,231,416 |
| properties-256 | 10,000 | 81,080,992 | 78,842,568 | Outside matched workload |

In the exploratory 256-byte baseline sample, the largest visible groups were encodePacket itself at 8.09 MB, properties at 6.36 MB, and utf8 at 5.23 MB. The exploratory property-heavy baseline sample attributed 30.18 MB to the properties-to-utf8 stack and 13.53 MB to its Uint8Array.of stack. V8 can inline joins, so those groups cannot assign all costs to a specific copy. The measured sampled totals stayed close despite removing one frame-sized backing store.

A separate Node field experiment compared TextEncoder.encode followed by a length-prefixed copy with counting UTF-8 bytes in JavaScript followed by encodeInto. After 2,000 warmup calls, three 100,000-call samples gave the following medians in milliseconds. The two methods produced equal bytes for each valid string.

| Input | Encode and copy | Count and encodeInto |
| --- | ---: | ---: |
| short-ascii | 54.8 | 72.0 |
| unicode | 70.0 | 70.9 |
| long-property | 496.1 | 680.7 |

The field experiment used `bench/topic`, `bench/é/😀/` followed by U+FEFF, and 128 repeats of `π😀`. Keep the existing field encoder. An encodeInto design would need a sizing strategy with evidence that it pays for the extra scan.

## Bundle and reproduction

The isolated minified Vite ESM codec measured 13,191 bytes before and 13,321 after. Gzip measured 3,938 and 4,031 bytes. This comparison excludes the rest of the client, test runner, and Node transport dependencies. The packed CI job separately checks the installed consumer.

Build the baseline and save its compiled `dist` directory. Build the candidate, then run `node test/bench/encode-compare.ts <baseline-dist>/codec.js` for Node timing and allocation stacks. Pass `--browser` for the Chromium timing and bundle results. Install the pinned Playwright browser first. The runner prints JSONL. Keep the run files with local or CI artifacts.

Keep the single frame assembly for PUBLISH. The measured gain comes with a small source change and unchanged wire bytes. Keep the property and string encoding work separate. This run sets no performance threshold and makes no parser replacement decision. Refs #56, #37 and #18.
