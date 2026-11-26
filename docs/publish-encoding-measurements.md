# PUBLISH encoding allocation and throughput

## Single-allocation PUBLISH frame

The PUBLISH encoder now sizes every field first, allocates the frame once and writes each field into it. It writes ASCII strings directly and passes the rest of a string to TextEncoder.encodeInto at the first non-ASCII code unit. The other packets still build their frames from encoded parts. The checks, their order and the wire bytes stay the same. A payload or Correlation Data view that changes size between sizing and writing raises RangeError.

The comparison used Node 26.13.0 and Chromium 158.0.8127.36 on Linux x64 with an Intel Xeon at 2.10 GHz. The baseline is the codec at `74234c0`. The runner and settings are the ones described below. The table shows the median and range in milliseconds for the call count shown.

| Workload | Calls | Node before | Node after | Node mqtt-packet | Chromium before | Chromium after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ascii-0 | 100,000 | 115.7 (105.8 to 152.3) | 23.2 (22.9 to 31.9) | 117.7 (93.4 to 118.6) | 198.3 (173.8 to 225.5) | 22.5 (17.1 to 37.0) |
| ascii-16 | 100,000 | 130.3 (105.3 to 159.8) | 22.9 (20.6 to 27.6) | 118.6 (115.8 to 121.4) | 182.0 (168.9 to 209.1) | 25.1 (18.0 to 31.3) |
| ascii-256 | 100,000 | 522.8 (293.2 to 531.9) | 216.2 (86.6 to 291.3) | 140.8 (139.7 to 146.3) | 281.3 (272.7 to 366.2) | 104.2 (96.0 to 119.6) |
| ascii-4096 | 16,384 | 71.5 (67.7 to 85.6) | 61.2 (45.0 to 88.2) | 42.3 (30.3 to 45.9) | 98.1 (86.1 to 181.3) | 51.1 (42.9 to 76.2) |
| ascii-65536 | 2,000 | 27.6 (25.5 to 27.6) | 24.2 (20.7 to 47.3) | 26.1 (22.5 to 31.3) | 104.7 (103.8 to 115.9) | 93.6 (92.2 to 97.1) |
| unicode-256 | 100,000 | 548.4 (370.1 to 577.6) | 159.8 (150.5 to 294.6) | 146.8 (129.7 to 163.2) | 309.4 (256.9 to 358.4) | 222.0 (169.9 to 262.0) |
| properties-256 | 100,000 | 2,928.4 (2,754.7 to 3,005.3) | 326.0 (277.2 to 376.1) | Outside matched workload | 1,867.9 (1,844.3 to 1,931.9) | 485.3 (386.7 to 500.7) |

Median sampled bytes from three runs, with the same sampling settings as the allocation table below:

| Workload | Calls | Portable before | Portable after | mqtt-packet |
| --- | ---: | ---: | ---: | ---: |
| ascii-256 | 10,000 | 21,984,816 | 11,521,896 | 23,290,168 |
| ascii-65536 | 2,000 | 4,456,184 | 2,341,728 | 5,183,232 |
| properties-256 | 10,000 | 80,669,792 | 23,588,968 | Outside matched workload |

The 4 KiB and 64 KiB ranges overlap, because the payload copy dominates them. The isolated minified Vite ESM codec measured 28,602 bytes before and 30,841 after. Gzip measured 7,368 and 7,976 bytes.

The installed client shows the same change. Five pairs of 500,000 sequential QoS 0 publishes through `test/bench/packed-qos0.ts` measured a median of 295,615 publishes per second on `74234c0` (263,220 to 313,770) and 426,145 with this encoder (398,220 to 462,310). V8 sampling estimated 4,704 allocated bytes per publish before and 3,051 after. With the same payload as bytes, the median was 637,158 publishes per second and 2,854 bytes per publish. With a Content Type, 4 bytes of Correlation Data and one User Property, the median was 141,620 before this encoder and 479,440 after, and the allocation estimate fell from 9,314 to 3,399 bytes per publish. A `--trace-deopt` run of each workload showed only single deoptimizations during warmup.

## Field assembly from encoded parts

The sections below record the earlier change, which assembled the frame from encoded fields.

The comparison used Node 26.13.0 and Chromium 158.0.8127.18 on WSL2 x64 with an AMD Ryzen 5 3600. The baseline is the portable codec at `4194394`. The Node comparison also uses pinned mqtt-packet 9.0.2 for workloads that produce the same bytes. The interleaved User Properties workload compares the two portable implementations because the retained parser package uses grouped properties.

The candidate computes Remaining Length from the already encoded fields and copies those fields into the final frame. It removes the intermediate PUBLISH body buffer and copies the payload once. Topic and property encoders still allocate temporary arrays. The copy cursor advances by the length of each copied field, and the fixed vectors test the 127, 128 and 16,384 Remaining Length boundaries. They also verify that changing the original payload view cannot affect the returned bytes. A growing input that no longer fits the captured frame size raises RangeError. The QoS 1 and decoder suites cover the remaining identifier, flags, fragmentation and malformed-input cases.

### Unprofiled elapsed time

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

### Allocation sampling

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

The field experiment used `bench/topic`, `bench/é/😀/` followed by U+FEFF, and 128 repeats of `π😀`. The single-allocation encoder above avoids the extra scan for ASCII, because it writes ASCII code units directly instead of calling encodeInto.

## Bundle and reproduction

The isolated minified Vite ESM codec measured 13,191 bytes before and 13,321 after. Gzip measured 3,938 and 4,031 bytes. This comparison excludes the rest of the client, test runner, and Node transport dependencies. The packed CI job separately checks the installed consumer.

Build the baseline and save its compiled `dist` directory. Build the candidate, then run `node test/bench/encode-compare.ts <baseline-dist>/codec.js` for Node timing and allocation stacks. Pass `--browser` for the Chromium timing and bundle results. Install the pinned Playwright browser first. The runner prints JSONL. Keep the run files with local or CI artifacts.

Keep the single frame assembly for PUBLISH. The measured gain comes with a small source change and unchanged wire bytes. Keep the property and string encoding work separate. This run sets no performance threshold and makes no parser replacement decision. Refs #56, #37 and #18.
