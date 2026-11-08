# Receive-limit validation observations

Captured on 8 November 2026 while verifying #76. These are incidental measurements from integration checks, not a repeatable performance baseline. Node was v26.13.0, Mosquitto was 2.0.18 and the packed browser check used Chromium 158.0.8127.18 with pinned Vite 8.3.6. The source limit implementation is 741d09874dee0041c03bf8ed155077ff530bb07a.

## Packed broker echo

The consumer subscribes to ci/echo, pings, then sequentially publishes decimal index strings and verifies the echoed topic, payload and QoS 0. Timing starts after connection and subscription. There is no warmup. It includes local broker and socket scheduling. The final cancellation checks run after measurement.

| Transport fixture | Echoes | Echoes/s | Reported p99 ms |
| --- | ---: | ---: | ---: |
| TCP | 100 | 4124.715 | 0.813200 |
| WS | 5 | 2508.299 | 0.720317 |
| Direct WSS | 5 | 1349.133 | 2.491683 |
| WSS with client certificate | 5 | 1307.010 | 2.547783 |
| WSS through CONNECT proxy | 1 | 1146.657 | 0.858600 |

The one- and five-echo samples are smoke-test output. Their reported p99 is the largest observed sample, not a reliable tail estimate. These runs do not compare transports fairly or justify performance thresholds. Certificate rejection and native browser/Node session probes report pass/fail without comparable timing. The proxy check counted two tested client cases; it separately asserted each case's expected tunnel count.

Reproduce with test/packed/broker.mjs installed beside a packed consumer and a running broker. Set MQTT_TEST_PORT and MQTT_TEST_ITERATIONS for TCP. The full WS/WSS certificate and proxy fixture is `bash test/packed/mosquitto-ws.sh <consumer-directory>`. It needs Mosquitto, OpenSSL and the pinned dependencies. CI owns broker setup and packed-consumer construction.

## Packed browser delivery

Each mode accepted and delivered 2,000 ordered messages with 256-byte payloads and checksum 1,999,000. The producer offered batches of sixteen and waited for consumption. This excludes MQTT encoding, decoding, broker throughput and network latency. Queue byte accounting includes payload and string data as defined in the [experiment](../message-stream-comparison.md).

| Mode | Elapsed ms | Messages/s | Delivery p99 ms | Peak queued messages | Peak accounted bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Callback | 7.6 | 263157.895 | 0 | 0 | 0 |
| Iterator | 13.3 | 150375.940 | 0.1 | 15 | 3870 |
| Web Streams | 12.5 | 160000.000 | 0.4 | 16 | 4128 |

A zero timing sample reflects timer resolution and synchronous work; it does not establish zero latency. This is one local run. Iterator break, stream cancellation and queue overflow each left zero queued entries and allowed subsequent protocol operations. The empty-close, source-failure and handed-message terminal probes passed.

## Browser graph sizes

| Bundled fixture | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Portable tracer plus test consumer | 5679 | 1927 |
| Full stream-comparison fixture | 27085 | Not measured |
| Isolated experimental queue module | 3114 | 1276 |

The portable tracer imports mqtt/portable. Its size is not the full browser client, codec or npm package size. The stream-comparison figure includes its test workload. The queue is experimental and is not a published export. These are Vite build outputs with the harness's current library settings, not production application savings or a minification comparison.

Run `node test/packed/browser-build.mjs <consumer-directory> chromium` after installing the tarball and the pinned Playwright browser. Omitting the engine runs declaration, bundle and installed Node receive checks without executing the browser comparison. The harness reports gzip through Node's gzipSync. Local transcripts are node-receive-packed.log and node-receive-ws-session.log outside the checkout; the tables preserve their quantitative observations with readable rounding.

## TCP packet-admission follow-up

The later packed run used b7b5e3b51fe5a5efa61e60a5e8ed7c12d532e773 with the same pinned tools and broker. The public TCP consumer set maxPacketBytes to 4096. All 100 sequential echo checks passed; the reported rate was 5315.414 echoes/s and p99 was 0.309834 ms. This small smoke run does not isolate decoder cost or establish a speedup over the earlier run.

The new installed-package probe also passed exact-limit Buffer ownership, declared excess, valid acknowledgment prefixes, fragmented lengths, partial EOF and readable EOF during an 8 MiB blocked outgoing write. These are contract checks, not additional performance samples. The outgoing payload is deliberately larger than the incoming limit; those budgets are separate.

The Chromium delivery rerun reported the following observations. Each mode again accepted and delivered 2,000 ordered messages with checksum 1,999,000.

| Mode | Elapsed ms | Messages/s | Delivery p99 ms | Peak queued messages | Peak accounted bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Callback | 6.7 | 298507.463 | 0 | 0 | 0 |
| Iterator | 12.9 | 155038.760 | 0.2 | 15 | 3870 |
| Web Streams | 11.2 | 178571.429 | 0.7 | 16 | 4128 |

| Bundled fixture | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Portable tracer plus test consumer | 5679 | 1927 |
| Full stream-comparison fixture | 27085 | Not measured |
| Isolated experimental queue module | 3114 | 1274 |

Raw graph sizes are unchanged in this rerun. The two-byte gzip difference in the queue fixture is an observation, not an optimization result. Ownership and terminal probes again passed. The local transcript is tcp-packet-packed.log outside the checkout. The same browser harness now runs the installed TCP capacity probe even when no browser engine is selected.

## Final TCP integration validation

The final local run used source and tests at 645c85d, including the shared CONNECT-refusal ordering fix at 1aaafce8126857ef3606c92a49a3f547d66b52bc. Tool versions and workloads match the earlier checks. All packed TCP capacity and EOF probes passed. Direct WS/WSS, client certificates, certificate rejection, cancellation and proxy checks also passed. Node WS/WSS still uses the existing parser, so these checks do not establish its per-packet capacity limit.

| Transport fixture | Echoes | Echoes/s | Reported p99 ms |
| --- | ---: | ---: | ---: |
| TCP | 100 | 4790.993 | 0.629659 |
| WS | 5 | 2158.203 | 0.923975 |
| Direct WSS | 5 | 2789.830 | 0.680935 |
| WSS with client certificate | 5 | 1205.226 | 2.555920 |
| WSS through CONNECT proxy | 1 | 1066.487 | 0.928034 |

| Mode | Elapsed ms | Messages/s | Delivery p99 ms | Peak queued messages | Peak accounted bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Callback | 6.3 | 317460.317 | 0 | 0 | 0 |
| Iterator | 11.8 | 169491.525 | 0.2 | 15 | 3870 |
| Web Streams | 10.9 | 183486.239 | 0.4 | 16 | 4128 |

Each Chromium mode again delivered 2,000 ordered messages with checksum 1,999,000. Iterator break, stream cancellation and queue overflow cleared queued entries; all terminal probes passed. The timer-resolution and sample-size limitations above still apply.

| Bundled fixture | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Portable tracer plus test consumer | 5830 | 1950 |
| Full stream-comparison fixture | 27236 | Not measured |
| Isolated experimental queue module | 3114 | 1276 |

The portable tracer grew by 151 raw bytes and 23 gzip bytes after the core refusal fix. The stream-comparison fixture grew by 151 raw bytes. These fixtures include consumer code and are not whole-package sizes. The queue module's raw size stayed unchanged. Local transcripts are tcp-packet-packed-final.log and tcp-packet-ws-session-final.log outside the checkout. These observations do not establish a performance regression or improvement; #18 owns controlled comparisons and thresholds.

## WebSocket packet integration validation

The WS/WSS integration run used source 3a20cc5273777e5e964c36a5d5812872e861f6f2 with the same pinned tools and host. Both public Node adapters now use compact packet admission. The broker consumer sets maxPacketBytes to 4096 for TCP and WS/WSS. The new installed WebSocket probe passed declaration-only limits, one-byte messages, fragmented lengths, pending-ACK excess, partial EOF and compact mutable Buffer ownership. Existing TCP, native message-limit, SSR, Chromium, certificate, cancellation and proxy probes also passed.

| Transport fixture | Echoes | Echoes/s | Reported p99 ms |
| --- | ---: | ---: | ---: |
| TCP | 100 | 5346.676 | 0.756158 |
| WS | 5 | 1154.623 | 2.381660 |
| Direct WSS | 5 | 1871.011 | 1.177236 |
| WSS with client certificate | 5 | 2676.896 | 0.674655 |
| WSS through CONNECT proxy | 1 | 928.117 | 1.064342 |

| Mode | Elapsed ms | Messages/s | Delivery p99 ms | Peak queued messages | Peak accounted bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Callback | 7.2 | 277777.778 | 0 | 0 | 0 |
| Iterator | 12.5 | 160000.000 | 1.0 | 15 | 3870 |
| Web Streams | 11.4 | 175438.596 | 0.7 | 16 | 4128 |

Each Chromium mode delivered 2,000 ordered messages with checksum 1,999,000. Break, cancel and overflow cleared queued entries and left protocol ownership intact. All terminal probes passed. This queue workload excludes the MQTT codec and broker, so its timing does not measure the Node decoder change.

| Bundled fixture | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Portable tracer plus test consumer | 5830 | 1951 |
| Full stream-comparison fixture | 27236 | Not measured |
| Isolated experimental queue module | 3114 | 1276 |

Raw fixture sizes match the previous run. The portable fixture's one-byte gzip variation is recorded without attributing a cause or declaring a regression. Browser graph checks still reject Node built-ins and external imports. These fixtures are not whole-package size measurements. Local transcripts are ws-packet-packed.log and ws-packet-ws-session.log outside the checkout. The earlier sampling and small-run limits apply; these observations set no threshold or transport ranking.
