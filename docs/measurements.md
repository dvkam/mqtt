# Measurement records

Keep workload, environment, tool versions, individual observations, summary and reproduction commands with each experiment. State what the measurement excludes. Record changed validation or ownership rules before comparing speed. Raw profiler output stays in local research files or CI artifacts unless a checked-in fixture is needed to reproduce a regression.

| Work                                   | Record                                                                                                    | Scope                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Pinned upstream comparison             | [Baseline data](baseline/results.jsonl) and [runner](baseline/measure.mjs)                                | Initial Node and browser reference workloads                                                         |
| Portable codec                         | [Codec measurements](codec.md#initial-measurements)                                                       | Encoding and decoding a 256-byte payload; three-run medians                                          |
| Application consumption                | [Queue comparison](message-stream-comparison.md)                                                          | Callback, iterator and Web Streams delivery; queue accounting and ownership                          |
| Fixed-rate delivery allocation         | [Burst profiles](fixed-rate-delivery-allocation.md)                                                       | Node and Chromium allocation stacks and separate unprofiled queue age                                |
| Ready message batches                  | [Batch comparison](ready-message-batches.md)                                                              | Iterator dispatch counts, allocation samples and oldest delivered age                                |
| Packed ready batches                   | [Browser network probe](packed-batch-network.md)                                                          | Oldest live backlog, control latency, dispatch and cleanup across three engines                      |
| Native TCP socket delay | [Six paired TLS observations](baseline/native-socket-delay.md) | Installed-artifact comparison of native buffering defaults; five echoes per session |
| WebSocket transport                    | [WS/WSS comparison](websocket-comparison.md)                                                              | TLS, proxy, bufferedAmount admission and close observations                                          |
| Receive-limit validation               | [8 November observations](baseline/receive-validation-measurements.md)                                    | Individual broker smoke timings, browser delivery and fixture bundle sizes                           |
| Bounded Node framing                   | [Individual measurements](baseline/node-framing-measurements.md) and [design](node-framing-experiment.md) | Compact assembly, streaming gate and native reference                                                |
| Node parser occupancy                  | [Individual observations](baseline/node-framing-occupancy.md)                                             | Native fragment bytes/items and compact assembly capacity; no allocation or timing claim             |
| Mixed traffic preview                  | [Six observations](baseline/mixed-traffic-probe.md) and [method](mixed-traffic-probe.md)                  | QoS 0 bursts, capacity rejection, ping, subscriptions, delayed echoes and same-process metrics       |
| Property decoding | [Three runs before and after](property-decoding.md#measurements) | Node decode throughput for packets with and without properties; no allocation or browser measurement |
| Packet identifier allocator            | [Set and bitset observations](baseline/packet-id-allocator.md)                                            | Sparse and nearly full occupancy, five repetitions per variant                                       |

The compact runner now uses the private production decoder described in [TCP packet input](tcp-packet-input.md) and [Node WebSocket packet input](websocket-packet-input.md). Historical prototype runs remain pinned in the measurement record. Decoder-only throughput excludes the input helper, session and native socket.

Local timing observations do not become CI thresholds automatically. #18 owns repeatable bundle, throughput, latency and memory baselines. #56 owns portable encoder allocation profiling. #75 owns the Node framing comparison and adoption decision. A passing protocol exchange or a small bundle does not establish a general performance advantage.

The [PUBLISH encoding comparison](publish-encoding-measurements.md) records unprofiled Node and Chromium timings, V8 allocation samples, and the isolated codec bundle for the single-frame assembly.

## Packed echo and V8 profiles

Build and pack the baseline and candidate. Install each tarball and the pinned `ws` peer into its own clean directory. Start [the pinned Mosquitto fixture](../test/packed/mosquitto-container.sh) with [the benchmark configuration](../test/bench/mosquitto.conf). Use the same runtime and broker for each side. The configuration sets `set_tcp_nodelay true` so the broker's TCP Nagle delay does not dominate the two responses in a QoS 1 echo.

```sh
MQTT_TEST_PORT=18882 bash test/bench/packed-echo.sh /path/to/baseline /path/to/candidate
MQTT_TEST_PORT=18882 MQTT_TEST_QOS=1 bash test/bench/packed-echo.sh /path/to/baseline /path/to/candidate
MQTT_TEST_WS_URL=ws://127.0.0.1:18881/mqtt node test/bench/packed-browser-echo.ts /path/to/baseline /path/to/candidate
```

The script runs five pairs in alternating order. Each fresh process checks inbound QoS 1, then measures 10,000 sequential TCP echoes by default. The publishing workload uses QoS 0 unless `MQTT_TEST_QOS=1` selects QoS 1. QoS 1 timings include waiting for the broker's PUBACK and for a QoS 0 echo to the subscriber. Each sample checks the echoed topic and payload. The output reports echo throughput and nearest-rank p50, p90, p95, and p99 round-trip latency. Preserve the individual observations, artifact versions, broker digest, and machine load. Compare medians and ranges. The probe includes client and broker work, and its sequential requests do not exercise burst capacity or browser delivery.

The Chromium script opens a fresh browser per run. It serves the installed package's bundle on a cross-origin-isolated loopback page. It checks 25 fresh MQTT connects and disconnects, then checks 1,000 warmup echoes and 10,000 measured echoes per publish QoS. Set `MQTT_BROWSER_PROFILE_DIR` to run separate candidate CPU and allocation sampling instead of the paired timings. The connection timing starts before factory construction and ends after CONNACK. The disconnect timing ends when the client releases the session. With 25 samples, p99 equals the maximum in each process.

For a separate profile, copy `test/packed/broker.mjs` into the installed consumer and run the same workload with one diagnostic at a time.

```sh
MQTT_TEST_PORT=18882 MQTT_TEST_ITERATIONS=10000 node --cpu-prof --cpu-prof-dir=/path/to/profiles /path/to/candidate/broker.mjs
MQTT_TEST_PORT=18882 MQTT_TEST_ITERATIONS=10000 node --heap-prof --heap-prof-dir=/path/to/profiles /path/to/candidate/broker.mjs
MQTT_TEST_PORT=18882 MQTT_TEST_ITERATIONS=10000 node --trace-opt --trace-deopt /path/to/candidate/broker.mjs > /path/to/profiles/v8.log
```

Use the CPU or allocation profile to pick a call site before investigating object shapes or type feedback in the V8 trace. Recheck a candidate with the profiler off and the same packet validation, byte ownership and ordering. Log the result under [#178](https://github.com/dvkam/mqtt/issues/178). Open a linked issue when a measured bottleneck needs its own change.

### CONNACK, disconnect drain and WebSocket message limits

On 25 November 2026, the signed `07b9b7b` baseline and a local candidate with the fixes under #149, #147 and #150 plus the shared forced close ran on the same Xeon Platinum 8573C cloud host. The host exposed five logical CPUs with a four-CPU cgroup quota. Node was 26.13.0 with V8 14.6.202.34-node.40. Chromium was 156.0.8078.79 with V8 15.6.75.27. Mosquitto 2.0.22 used the pinned digest in the fixture and the benchmark configuration above. The load average before the paired runs was 0.60 over one minute.

Every run completed its checked echoes. TCP measured 50,000 echoes per run and publishing QoS. Chromium measured 10,000 after warmup. Each number is the median of five run results, with its range in parentheses. Each latency column is in milliseconds.

| Client and publish QoS | Package | Echoes/s | p50 | p90 | p95 | p99 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Node TCP, 0 | Baseline | 21,871 (21,124 to 23,728) | 0.039 (0.038 to 0.039) | 0.060 (0.055 to 0.063) | 0.088 (0.081 to 0.091) | 0.195 (0.188 to 0.217) |
| Node TCP, 0 | Candidate | 20,384 (16,029 to 23,515) | 0.039 (0.038 to 0.049) | 0.070 (0.055 to 0.076) | 0.105 (0.078 to 0.117) | 0.240 (0.181 to 0.500) |
| Node TCP, 1 | Baseline | 17,834 (14,128 to 19,177) | 0.043 (0.042 to 0.050) | 0.076 (0.070 to 0.087) | 0.114 (0.103 to 0.133) | 0.260 (0.253 to 0.424) |
| Node TCP, 1 | Candidate | 19,427 (17,138 to 21,091) | 0.043 (0.041 to 0.044) | 0.070 (0.064 to 0.078) | 0.103 (0.092 to 0.111) | 0.238 (0.227 to 0.255) |
| Chromium WS, 0 | Baseline | 3,821 (3,139 to 3,993) | 0.220 (0.215 to 0.270) | 0.380 (0.335 to 0.450) | 0.465 (0.410 to 0.530) | 0.815 (0.740 to 1.165) |
| Chromium WS, 0 | Candidate | 3,582 (3,290 to 3,764) | 0.230 (0.215 to 0.255) | 0.415 (0.380 to 0.425) | 0.505 (0.465 to 0.605) | 1.245 (0.865 to 1.990) |
| Chromium WS, 1 | Baseline | 2,438 (2,213 to 2,669) | 0.355 (0.310 to 0.380) | 0.580 (0.535 to 0.605) | 0.685 (0.670 to 0.775) | 1.445 (1.105 to 1.925) |
| Chromium WS, 1 | Candidate | 2,459 (2,187 to 2,628) | 0.350 (0.330 to 0.355) | 0.585 (0.560 to 0.670) | 0.695 (0.660 to 1.005) | 1.170 (0.980 to 2.335) |

The measurements overlap for each client and QoS. The variation leaves the candidate's effect on steady echo throughput and tail latency inconclusive. The browser connect medians were 110.595 ms and 110.620 ms. Browser disconnect medians were 0.630 ms and 0.775 ms. These connect and disconnect measurements used an idle session with zero active publications.

With broker defaults, a separate 50-echo Node QoS 1 calibration measured 43.989 ms p50. Setting `set_tcp_nodelay true` on the same broker image measured 0.137 ms. These two calibration runs explain why the 50,000-echo test with broker defaults reached its 60-second process deadline. The table uses the low-latency setting on both sides.

The separate 200,000-echo Node QoS 0 CPU run had 8,847 samples. Idle accounted for 4,189 and native `writeBuffer` for 2,762. `wireCodec.variable` had 67 direct samples and `validateTopic` had 44. The separate Chromium profile across QoS 0 and QoS 1 had 14,024 samples. Idle accounted for 7,416 and browser writer calls for 1,419. `validateTopic` had 221 direct samples. Chromium allocation sampling counted 14.6 MB at `validateTopic` across 42,000 checked echoes including warmup. This sampled estimate includes objects collected during the run. The Node `--heap-prof` snapshot includes surviving allocations and module startup, so it cannot estimate total bytes allocated per echo.

A separate Node optimization trace recorded 13 wrong-map deoptimizations across packet handling, encoding, stream writes, and cleanup. Topic validation, encoding, and the core send path each appeared once. The trace does not establish a repeated steady cost from shape changes. The next comparison targets the topic validation allocations identified in the browser profile.

### Topic validation allocations

A publish topic cannot contain `+` or `#`. The valid name path now checks string constraints without splitting the topic into levels. Any valid UTF-16 string of at most 21,845 code units fits in 65,535 UTF-8 bytes, so short values skip the temporary encoding. Longer values still check the exact byte length. The tests cover single-level and multi-level wildcards, unpaired surrogates, and the byte boundary for ASCII, two-byte, three-byte, and astral characters.

The focused comparison used the preceding candidate with and without this topic change. The installed in-memory byte writer consumed 500,000 sequential QoS 0 publications per run with a fixed 16-byte payload after 10,000 warmup writes. The fixture counted every publication and checked the full wire vector every 1,024 writes. The paired TCP workload checked 100,000 echoes per run with the same broker configuration as above. Entries are medians of five runs with the range in parentheses. Latencies are in milliseconds.

| Workload | Topic validation | Operations/s | p50 | p90 | p95 | p99 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| In-memory byte writer | Before | 193,220 (162,567 to 198,963) | 0.00348 (0.00342 to 0.00361) | 0.00504 (0.00490 to 0.00595) | 0.00684 (0.00635 to 0.00776) | 0.03413 (0.02762 to 0.04285) |
| In-memory byte writer | After | 238,129 (222,320 to 253,977) | 0.00286 (0.00284 to 0.00289) | 0.00402 (0.00385 to 0.00418) | 0.00532 (0.00503 to 0.00556) | 0.02398 (0.02033 to 0.02810) |
| TCP echo | Before | 18,020 (15,330 to 21,434) | 0.03869 (0.03777 to 0.04780) | 0.08616 (0.06142 to 0.11483) | 0.13195 (0.09286 to 0.19068) | 0.41694 (0.21800 to 0.52155) |
| TCP echo | After | 20,074 (10,776 to 21,757) | 0.03779 (0.03726 to 0.05109) | 0.07033 (0.05700 to 0.17252) | 0.10653 (0.08742 to 0.27199) | 0.24440 (0.21222 to 0.63637) |

The client-only median increased 23%. The TCP ranges overlap. The in-memory result measures the installed client with a completed write promise and no network. The packed TCP profile shows that native socket writes account for most of the active samples in that workload. [In-memory workload](../test/bench/packed-qos0.ts) · [#178](https://github.com/dvkam/mqtt/issues/178)

### Shared QoS 0 write deadline

The reviewed shared deadline replaced one timer and Promise race per QoS 0 write. Each write still has its own expiry. Retirement uses the oldest pending expiry. The final version checks this expiry before accepting a completion and drops the session reference when the timer is idle. A separate timer-count run recorded 1,000 calls before and zero after for 1,000 measured sequential writes after warmup. The operation test also checks a fresh session, which may arm its first timer once.

The baseline includes the topic validation optimization. Five pairs measured 500,000 synthetic publishes, 100,000 TCP echoes and 5,000 Chromium echoes per run. Chromium also performed 1,000 warmup echoes per QoS. Each latency column is in milliseconds. Parentheses show the range of the five runs.

| Workload | Timer | Operations/s | p50 | p90 | p95 | p99 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| In-memory QoS 0 | Per write | 218,891 (212,540 to 249,505) | 0.00288 (0.00283 to 0.00289) | 0.00408 (0.00387 to 0.00416) | 0.00540 (0.00509 to 0.00754) | 0.02962 (0.02214 to 0.03811) |
| In-memory QoS 0 | Shared | 263,223 (258,610 to 317,884) | 0.00218 (0.00214 to 0.00219) | 0.00338 (0.00313 to 0.00356) | 0.00427 (0.00393 to 0.00448) | 0.02035 (0.01359 to 0.02658) |
| TCP QoS 0 echo | Per write | 20,638 (18,729 to 21,878) | 0.03799 (0.03733 to 0.04620) | 0.06641 (0.05549 to 0.07262) | 0.09293 (0.07533 to 0.11073) | 0.22396 (0.16136 to 0.27346) |
| TCP QoS 0 echo | Shared | 20,625 (18,629 to 24,584) | 0.03729 (0.03672 to 0.03879) | 0.06796 (0.05555 to 0.07244) | 0.10524 (0.08538 to 0.11038) | 0.26434 (0.20564 to 0.27221) |
| Chromium QoS 0 echo | Per write | 3,619 (2,256 to 3,860) | 0.225 (0.210 to 0.355) | 0.405 (0.385 to 0.705) | 0.500 (0.475 to 0.945) | 0.890 (0.805 to 1.970) |
| Chromium QoS 0 echo | Shared | 3,952 (3,135 to 4,716) | 0.220 (0.180 to 0.270) | 0.390 (0.310 to 0.465) | 0.500 (0.395 to 0.575) | 0.860 (0.725 to 1.280) |

Median client-only throughput increased 20%. In five separate pairs of 200,000 publishes, V8 sampling estimated 6,345 allocated bytes per publish before (6,308 to 6,400) and 4,700 after (4,681 to 4,716). The estimate includes collected objects at a 32,768-byte sampling interval. The echo ranges overlap. Chromium QoS 1 throughput, which uses the acknowledgment deadline, also overlapped at 2,616 and 2,642 median echoes per second.

To repeat the client-only comparison, copy `test/bench/packed-qos0.ts` and `test/experiments/latencies.ts` into `bench` and `experiments` subdirectories of each consumer, preserving that relative layout. Run the commands from both consumers in alternating order.

```sh
MQTT_TEST_ITERATIONS=500000 node bench/packed-qos0.ts
MQTT_TEST_TIMER_COUNT=1 MQTT_TEST_ITERATIONS=1000 node bench/packed-qos0.ts
MQTT_QOS0_HEAP_PROFILE=/path/to/qos0.heapprofile node bench/packed-qos0.ts
```

Set `MQTT_QOS0_WORKLOAD` to `bytes` to publish the payload as a Uint8Array, or to `properties` to add a Content Type, Correlation Data and a User Property. The default is `text`. The [PUBLISH encoding comparison](publish-encoding-measurements.md) records these workloads for the single-allocation encoder.

The full lifecycle replay passed 43 positive models and found all 152 expected faults. The packed Chromium retirement probe observed no remaining timers or listeners after close. [Operation tests](../test/operation-timeout.test.ts) · [Deadline model](../verification/QosZeroDeadline.tla) · [#156](https://github.com/dvkam/mqtt/issues/156)

### Will codec comparison

Five paired runs before and after the Will change measured steady echo with no Will configured. They checked 50,000 TCP and 5,000 Chromium echoes per process and QoS. Values are medians, with p99 ranges in parentheses. The observed timing ranges overlap. The broker checks separately registered and observed Will messages on all three transports. [Will checks](will-message.md)

| Workload | Package | p50 ms | p90 ms | p95 ms | p99 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| TCP QoS 0 | Before | 0.037 | 0.065 | 0.097 | 0.250 (0.222 to 0.273) |
| TCP QoS 0 | Will | 0.038 | 0.067 | 0.097 | 0.245 (0.230 to 0.268) |
| TCP QoS 1 | Before | 0.042 | 0.071 | 0.102 | 0.272 (0.181 to 0.284) |
| TCP QoS 1 | Will | 0.042 | 0.071 | 0.105 | 0.285 (0.252 to 0.304) |
| Chromium QoS 0 | Before | 0.220 | 0.385 | 0.465 | 0.755 (0.680 to 0.835) |
| Chromium QoS 0 | Will | 0.185 | 0.320 | 0.395 | 0.715 (0.640 to 0.760) |
| Chromium QoS 1 | Before | 0.335 | 0.545 | 0.625 | 0.970 (0.860 to 1.105) |
| Chromium QoS 1 | Will | 0.315 | 0.505 | 0.605 | 0.930 (0.840 to 1.120) |

### TCP bursts and delayed consumers

The TCP burst experiment records socket write calls and the effect of first-write submission with a corked tail. The mixed traffic probe checks deliberate capacity refusal, delayed echoes, control traffic, event-loop delay, and post-GC memory against separately installed packages. [TCP and TLS bursts](baseline/tcp-burst.md) · [Mixed traffic method](mixed-traffic-probe.md)

### Connection and acknowledgment results

On 25 November 2026, five paired runs compared installed packages before and after adding connection and subscription results. Both packages include the TCP burst change. Node 26.13.0 with V8 14.6.202.34-node.40 ran 50,000 checked TCP echoes per process and QoS. Chromium 156.0.8078.79 with V8 15.6.75.27 ran 5,000 checked WebSocket echoes per process and QoS after 1,000 warmup echoes. Both used the pinned Mosquitto 2.0.22 fixture with `set_tcp_nodelay true`. Table entries are medians of the five runs, with the p99 range in parentheses.

| Workload | Package | Echoes/s | p50 ms | p90 ms | p95 ms | p99 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| TCP QoS 0 | Before | 18,326 | 0.041 | 0.073 | 0.108 | 0.256 (0.228 to 0.436) |
| TCP QoS 0 | Results | 19,588 | 0.039 | 0.071 | 0.111 | 0.281 (0.232 to 0.354) |
| TCP QoS 1 | Before | 16,666 | 0.051 | 0.089 | 0.137 | 0.285 (0.258 to 0.332) |
| TCP QoS 1 | Results | 16,633 | 0.043 | 0.090 | 0.136 | 0.310 (0.281 to 0.350) |
| Chromium QoS 0 | Before | 3,651 | 0.230 | 0.410 | 0.515 | 0.900 (0.750 to 1.130) |
| Chromium QoS 0 | Results | 3,502 | 0.230 | 0.415 | 0.515 | 0.930 (0.750 to 0.965) |
| Chromium QoS 1 | Before | 2,531 | 0.345 | 0.570 | 0.690 | 1.285 (0.985 to 1.870) |
| Chromium QoS 1 | Results | 2,387 | 0.355 | 0.605 | 0.730 | 1.395 (0.895 to 2.005) |

The individual-run ranges overlap for throughput and all four echo percentiles. The Chromium runner also measured 25 fresh WebSocket connects and disconnects per process. Median connection p99 was 116.765 ms before and 115.180 ms after. Disconnect p99 was 4.480 ms before and 2.250 ms after. The connection and disconnect p99 ranges overlap. [Browser runner](../test/bench/packed-browser-echo.ts) · [#152](https://github.com/dvkam/mqtt/issues/152)

Five pairs of 100 fresh connections per process also measured Node TCP and TLS lifecycle latency. TCP connect p99 was 3.620 ms before and 2.937 ms after. TLS connect p99 was 7.431 ms before and 7.072 ms after. TCP disconnect p99 was 0.828 ms before and 0.765 ms after. TLS disconnect p99 was 1.281 ms before and 0.903 ms after. The p99 ranges overlap in every comparison. TLS verified the broker against the fixture CA on every connect.

Separate profile processes used the final package. A 200,000-echo Node CPU profile recorded 9,907 samples, including 5,272 idle and 2,589 in native `writeBuffer`. The largest package self-sample counts were 80 in `encodePacket` and 70 in `variable`. A Chromium CPU profile recorded 8,297 samples, with 4,640 idle and 841 in the browser transport's `write`. The Node optimization trace recorded ten wrong-map deoptimizations. The trace identifies sites for targeted probes. The timing runs used neither profiler nor trace. The final TCP burst trace recorded four `write` calls and one `writev` for a 1,000-publish burst and its CONNECT, SUBSCRIBE and DISCONNECT.

A separate 200,000-echo Node QoS 1 CPU profile recorded 11,128 samples, including 5,550 idle and 2,586 in native `writeBuffer`. Timer insertion and removal accounted for 112 and 90 samples. Those counts include the probe's echo deadline. The QoS 1 trace recorded eleven wrong-map deoptimizations over 100,000 echoes. Each QoS 1 profile and trace completed the installed client's active cancellation check.

The browser fixture also compared the signed work base `07b9b7b` against the complete local package. Its minified entry was 58,005 bytes before and 68,995 bytes after. Gzip size rose from 14,433 to 17,257 bytes. This comparison includes all changes since the signed base. [Browser build fixture](../test/packed/browser-build.ts)

### Single-byte Remaining Length prototype

A temporary installed copy emitted a single byte directly when the variable-byte integer was below 128. Eight wire checks covered all four length widths. Five pairs of 500,000 client-only publishes measured 282,385 (244,752 to 313,746) operations per second with the final package and 289,348 (275,593 to 332,676) with the prototype. Client-only p50 moved from 0.00217 to 0.00205 ms and p99 from 0.01713 to 0.01913 ms. Five pairs of 50,000 TCP echoes measured 22,488 (18,971 to 24,882) per second with the final package and 24,659 (18,662 to 25,508) with the prototype. TCP p99 was 0.231 (0.213 to 0.257) and 0.224 (0.211 to 0.287) ms. The throughput and p99 ranges overlap, and the prototype stayed outside the package. [#178](https://github.com/dvkam/mqtt/issues/178)

### Public transport comparison

On 24 November 2026, the pinned Mosquitto 2.0.22 fixture ran on Linux x64 in a five CPU cloud machine. The compared tarballs contained `1c9fb4e` and `4e56286`. The client ran Node 26.13.0 with V8 14.6.202.34-node.40. Both sides completed 50,000 checked echoes across five runs. The figures below are medians with the ranges in parentheses.

| Revision | Echoes per second | p99 echo latency in ms |
| --- | ---: | ---: |
| `1c9fb4e` | 37,623 (34,503–61,857) | 0.113 (0.097–0.126) |
| `4e56286` | 40,968 (39,152–47,846) | 0.116 (0.098–0.125) |

The difference is smaller than the run variation. A separate 200,000-echo CPU profile of `4e56286` captured 5,369 samples, including 2,328 idle samples. Native `writeBuffer` accounted for 1,646 samples. The largest package function by self samples was `wireCodec.join` with 128, followed by `wireCodec.variable` with 89. Those are candidates for a focused encoder workload. The V8 trace also recorded wrong-map deoptimizations in `encodePacket` and the shared send path. This trace does not show a repeated steady-state cost from those deoptimizations. The profile runs are excluded from the timing table.

### Server Keep Alive comparison

The same machine compared `4e56286` and `5e3ff5a` with 50,000 TCP echoes per run. The first configuration used broker defaults. The second set `max_keepalive 4`. A raw CONNECT probe confirmed that this broker returned Server Keep Alive `4` for CONNECT Keep Alive `0`. Both configurations used the same Mosquitto image. Each of the five pairs completed all echoes.

| Broker configuration | Baseline echoes per second | Candidate echoes per second | Baseline p99 in ms | Candidate p99 in ms |
| --- | ---: | ---: | ---: | ---: |
| Default | 46,024 (39,937–62,536) | 42,917 (37,267–47,905) | 0.084 (0.077–0.093) | 0.089 (0.085–0.109) |
| `max_keepalive 4` | 41,372 (39,587–44,359) | 41,510 (34,634–53,329) | 0.094 (0.080–0.107) | 0.087 (0.074–0.106) |

The pairs varied in both directions. The results do not establish a throughput or p99 change from the override. The echo probe measures steady writes. A separate installed-client check left the connection idle and observed two PINGRESPs from Mosquitto.

### Empty property sections

The encoder used to join an empty array of properties, encode its length, then join the two buffers. A single zero byte represents an empty property section. The encoder now writes that byte directly into a fresh array.

Five fresh processes per variant encoded 600,000 QoS 0 packets after 50,000 warmup encodes. Each process checked a fixed wire vector and accumulated a checksum from the output. The packet used topic `ci/echo`, a 16 byte payload and no properties. Median time fell from 600 ms (591–618) to 439 ms (434–459), a 27% reduction in this encoder workload. In a separate comparison, `Uint8Array.of(0)` reduced the encoder median from 624 ms to 462 ms, while its packed TCP median fell from 46,095 to 42,781 echoes per second.

For the fresh array variant, five paired runs of 100,000 packed TCP echoes yielded medians of 40,778 (37,797–48,283) and 44,922 (39,554–57,777) echoes per second. Median p99 was 0.080 ms (0.068–0.094) and 0.074 ms (0.063–0.086). The ranges overlap. The measured speedup applies to the isolated encoder workload. [#178](https://github.com/dvkam/mqtt/issues/178)

| Pair | Encoder baseline in ms | Encoder candidate in ms | Packed baseline echoes per second | Packed candidate echoes per second | Packed p99 baseline and candidate in ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 590.7 | 433.6 | 45,118 | 39,554 | 0.078 / 0.086 |
| 2 | 606.1 | 459.3 | 48,283 | 48,149 | 0.068 / 0.071 |
| 3 | 593.5 | 433.9 | 40,778 | 43,665 | 0.080 / 0.082 |
| 4 | 600.4 | 443.4 | 37,797 | 57,777 | 0.094 / 0.063 |
| 5 | 618.3 | 439.4 | 40,697 | 44,922 | 0.083 / 0.074 |

To reproduce the encoder timing, save this as `encode-empty-properties.mjs` in both installed consumer directories. Run `node encode-empty-properties.mjs` in each directory for five pairs, alternating which goes first. For the packed comparison, run the paired echo command above with `MQTT_TEST_ITERATIONS=100000`.

```js
import assert from 'node:assert/strict';
import { encodePacket } from 'mqtt/codec';

const packet = { cmd: 'publish', topic: 'ci/echo', payload: new Uint8Array(16).fill(0xa5), retain: false };
const expected = [0x30, 26, 0, 7, 99, 105, 47, 101, 99, 104, 111, 0, ...packet.payload];
assert.deepEqual([...encodePacket(packet)], expected);
for (let i = 0; i < 50000; i++) encodePacket(packet);
let checksum = 0;
const start = performance.now();
for (let i = 0; i < 600000; i++) {
  const encoded = encodePacket(packet);
  checksum += encoded[encoded.length - 1];
}
const ms = performance.now() - start;
assert.equal(checksum, 600000 * 0xa5);
console.log(JSON.stringify({ ms, packets: 600000, checksum }));
```
