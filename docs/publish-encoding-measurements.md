# PUBLISH encoding allocation and throughput

## Single-allocation PUBLISH frame

The PUBLISH encoder now reads each field and User Property once, sizes it, allocates the frame once and writes the values it checked into it. It writes ASCII strings directly and passes the rest of a string to TextEncoder.encodeInto at the first non-ASCII code unit. The other packets still build their frames from encoded parts. For a Uint8Array payload and fields without getters, the checks, their order and the wire bytes stay the same. A payload or Correlation Data that is not a Uint8Array, such as a DataView or a Uint16Array, now raises `RangeError: Invalid MQTT binary data`. Before, a DataView was encoded as zeros and a Uint16Array as truncated element values. The encoder sizes a payload by its own length and ignores a subclass `byteLength` getter. A payload or Correlation Data whose buffer is resized between sizing and writing, for example by a Subscription Identifier getter, raises `RangeError: MQTT bytes changed during encoding`.

The comparison used Node 26.13.0 and Chromium 158.0.8127.36 on Linux x64 with an Intel Xeon at 2.10 GHz. The baseline is the codec at `74234c0`. The runner and settings are the ones described below. The table shows the median and range in milliseconds for the call count shown.

| Workload | Calls | Node before | Node after | Node mqtt-packet | Chromium before | Chromium after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ascii-0 | 100,000 | 136.0 (122.2 to 172.7) | 25.2 (23.8 to 35.0) | 123.3 (121.9 to 131.6) | 208.5 (190.2 to 215.0) | 27.6 (18.3 to 42.3) |
| ascii-16 | 100,000 | 124.1 (123.4 to 137.5) | 26.8 (23.9 to 27.0) | 125.8 (125.0 to 128.5) | 193.4 (191.3 to 222.1) | 35.1 (24.8 to 43.9) |
| ascii-256 | 100,000 | 541.3 (414.8 to 630.1) | 193.0 (86.4 to 245.1) | 140.3 (126.5 to 151.9) | 307.7 (296.3 to 311.6) | 110.4 (100.5 to 160.1) |
| ascii-4096 | 16,384 | 73.6 (42.7 to 80.8) | 46.7 (39.8 to 62.1) | 37.0 (30.3 to 39.0) | 99.3 (91.6 to 196.9) | 70.9 (56.8 to 77.9) |
| ascii-65536 | 2,000 | 34.1 (31.5 to 40.0) | 27.5 (24.9 to 39.9) | 28.3 (19.4 to 30.2) | 100.8 (88.0 to 109.3) | 99.5 (96.0 to 108.1) |
| unicode-256 | 100,000 | 554.8 (355.4 to 561.3) | 193.1 (126.7 to 302.2) | 167.9 (150.8 to 199.3) | 318.8 (294.3 to 377.4) | 218.6 (177.5 to 218.8) |
| properties-256 | 100,000 | 3,000.9 (2,811.4 to 3,159.1) | 395.7 (326.9 to 421.4) | Outside matched workload | 2,014.0 (1,911.4 to 2,103.6) | 507.6 (405.7 to 530.1) |

Median sampled bytes from three runs, with the same sampling settings as the allocation table below:

| Workload | Calls | Portable before | Portable after | mqtt-packet |
| --- | ---: | ---: | ---: | ---: |
| ascii-256 | 10,000 | 21,931,408 | 6,985,600 | 22,968,664 |
| ascii-65536 | 2,000 | 4,443,592 | 1,414,352 | 5,124,352 |
| properties-256 | 10,000 | 80,358,144 | 18,406,184 | Outside matched workload |

In Node, the 4 KiB and 64 KiB ranges overlap, because the payload copy dominates them. In Chromium, the 4 KiB case is faster and the 64 KiB ranges overlap. The isolated minified Vite ESM codec measured 28,602 bytes before and 30,980 after. Gzip measured 7,368 and 8,048 bytes.

The installed client shows the same change. Five pairs of 500,000 sequential QoS 0 publishes through `test/bench/packed-qos0.ts` measured a median of 278,399 publishes per second on `74234c0` (271,150 to 281,700) and 391,894 with this encoder (383,810 to 420,020). V8 sampling estimated 4,707 allocated bytes per publish before and 3,027 after. With the same payload as bytes, the median was 565,314 publishes per second and 2,825 bytes per publish. With a Content Type, 4 bytes of Correlation Data and one User Property, the median was 426,826 publishes per second and 3,556 bytes per publish. An earlier run of the first commit of this change, which used the earlier encoder, measured 141,620 publishes per second and 9,314 bytes per publish for that workload. A `--trace-deopt` run of each workload showed only single deoptimizations during warmup.

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
