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
