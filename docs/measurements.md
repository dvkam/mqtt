# Measurement records

Keep workload, environment, tool versions, individual observations, summary and reproduction commands with each experiment. State what the measurement excludes. Record changed validation or ownership rules before comparing speed. Raw profiler output stays in local research files or CI artifacts unless a checked-in fixture is needed to reproduce a regression.

| Work                                   | Record                                                                                                    | Scope                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Duplicate CONNACK receipt | [Packed observations](baseline/duplicate-connack-checks.md) | Installed TLS/WS single-CONNACK controls after receipt tracking; no performance comparison |
| Session Present agreement | [Packed observations](baseline/session-present-checks.md) | Installed TLS/WS controls after the Clean Start guard; no performance comparison |
| Connection agreement | [Packed observations](baseline/connack-agreement-checks.md) | Installed TLS/WS sessions after authentication and identity checks; no performance comparison |
| Property cardinality and values | [Packed observations](baseline/property-value-checks.md) | Installed TLS/WS sessions after scalar checks; no controlled performance comparison |
| Pinned upstream comparison             | [Baseline data](baseline/results.jsonl) and [runner](baseline/measure.mjs)                                | Initial Node and browser reference workloads                                                         |
| Portable codec                         | [Codec measurements](codec.md#initial-measurements)                                                       | Encoding and decoding a 256-byte payload; three-run medians                                          |
| Application consumption                | [Queue comparison](message-stream-comparison.md)                                                          | Callback, iterator and Web Streams delivery; queue accounting and ownership                          |
| Fixed-rate delivery allocation         | [Burst profiles](fixed-rate-delivery-allocation.md)                                                       | Node and Chromium allocation stacks and separate unprofiled queue age                                |
| Ready message batches                  | [Batch comparison](ready-message-batches.md)                                                              | Iterator dispatch counts, allocation samples and oldest delivered age                                |
| Packed ready batches                   | [Browser network probe](packed-batch-network.md)                                                          | Oldest live backlog, control latency, dispatch and cleanup across three engines                      |
| Native TCP socket delay | [Six paired TLS observations](baseline/native-socket-delay.md) | Installed-artifact comparison of native buffering defaults; five echoes per session |
| DISCONNECT property validation | [Packed observations](baseline/disconnect-property-checks.md) | Installed TLS/WS smoke exchanges; no measured performance change |
| ACK property validation | [Packed observations](baseline/ack-property-checks.md) | Installed TLS/WS exchanges after the ACK guard; no performance comparison |
| PUBLISH property validation | [Packed observations](baseline/publish-property-checks.md) | Installed TLS/WS sessions after the byte guard; no controlled performance comparison |
| TCP TLS                                | [Packed fixture observations](baseline/tcp-tls-checks.md)                                                 | Authenticated MQTT exchanges and five-echo smoke timings                                             |
| WebSocket transport                    | [WS/WSS comparison](websocket-comparison.md)                                                              | TLS, proxy, bufferedAmount admission and close observations                                          |
| Receive-limit validation               | [8 November observations](baseline/receive-validation-measurements.md)                                    | Individual broker smoke timings, browser delivery and fixture bundle sizes                           |
| Bounded Node framing                   | [Individual measurements](baseline/node-framing-measurements.md) and [design](node-framing-experiment.md) | Compact assembly, streaming gate and native reference                                                |
| Node parser occupancy                  | [Individual observations](baseline/node-framing-occupancy.md)                                             | Native fragment bytes/items and compact assembly capacity; no allocation or timing claim             |
| Mixed traffic preview                  | [Six observations](baseline/mixed-traffic-probe.md) and [method](mixed-traffic-probe.md)                  | QoS 0 bursts, capacity rejection, ping, subscriptions, delayed echoes and same-process metrics       |
| Concurrent subscriptions               | [CI observations](baseline/concurrent-subscriptions-checks.md)                                            | Individual packed-broker echo timings and fixture bundle sizes; no controlled performance comparison |
| QoS 1 wire profile                     | [CI observations](baseline/qos1-wire-checks.md)                                                           | Packed QoS 0 echo timings and bundle sizes after expanding the codec                                 |
| Outbound QoS 1                         | [CI observations](baseline/qos1-outbound-checks.md)                                                       | Packed QoS 1 exchange validation, QoS 0 echo timings and fixture sizes                               |
| Property decoding | [Three runs before and after](property-decoding.md#measurements) | Node decode throughput for packets with and without properties; no allocation or browser measurement |
| Packet identifier allocator            | [Set and bitset observations](baseline/packet-id-allocator.md)                                            | Sparse and nearly full occupancy, five repetitions per variant                                       |
| Shared unsubscribe                     | [CI observations](baseline/unsubscribe-checks.md)                                                         | Packed unsubscribe validation, QoS 0 echo timings and fixture sizes                                  |
| Inbound QoS 1                          | [CI and local observations](baseline/qos1-inbound-checks.md)                                              | Packed delivery validation, QoS 0 echo timings and browser fixture measurements                      |
| Subscription acknowledgment validation | [CI observations](baseline/subscription-protocol-checks.md)                                               | Valid broker echo timings and fixture bundle sizes                                                   |
| Parser acknowledgment reporting        | [CI observations](baseline/parser-ack-checks.md)                                                          | Valid broker echo timings and fixture bundle sizes                                                   |
| Legacy TLS and comment audit           | [CI observations](baseline/legacy-audit-checks.md)                                                        | Valid broker echo timings and fixture bundle sizes                                                   |
| Session lint cleanup                   | [CI observations](baseline/lint-audit-checks.md)                                                          | Valid broker echo timings and fixture bundle sizes                                                   |

The compact runner now uses the private production decoder described in [TCP packet input](tcp-packet-input.md) and [Node WebSocket packet input](websocket-packet-input.md). Historical prototype runs remain pinned in the measurement record. Decoder-only throughput excludes the input helper, session and native socket.

Local timing observations do not become CI thresholds automatically. #18 owns repeatable bundle, throughput, latency and memory baselines. #56 owns portable encoder allocation profiling. #75 owns the Node framing comparison and adoption decision. A passing protocol exchange or a small bundle does not establish a general performance advantage.

The [historical dependency removal observations](baseline/dependency-removal.md) preserve PR #59's installed-tree, bundle and broker checks, including the correction that the after tree came from an incremental update.

The [PUBLISH encoding comparison](publish-encoding-measurements.md) records unprofiled Node and Chromium timings, V8 allocation samples, and the isolated codec bundle for the single-frame assembly.

## Packed echo and V8 profiles

Build and pack the baseline and candidate. Install each tarball and the pinned `ws` peer into its own clean directory. Start [the pinned Mosquitto fixture](../test/packed/mosquitto-container.sh) with [the TCP configuration](../test/packed/mosquitto.conf). Use the same Node version and broker for all runs.

```sh
MQTT_TEST_PORT=18883 bash test/bench/packed-echo.sh /path/to/baseline /path/to/candidate
```

The script runs five pairs in alternating order. Each fresh process checks the QoS 1 exchange, then measures 10,000 sequential QoS 0 TCP echoes by default. Each sample checks the echoed topic and payload. The output reports echo throughput and p99 round-trip latency. Preserve the individual observations, artifact commits, broker digest, and machine load. Compare medians and ranges. The probe includes client and broker work, and its sequential requests do not exercise burst capacity or browser delivery.

For a separate profile, copy `test/packed/broker.mjs` into the installed consumer and run the same workload with one diagnostic at a time.

```sh
MQTT_TEST_PORT=18883 MQTT_TEST_ITERATIONS=10000 node --cpu-prof --cpu-prof-dir=/path/to/profiles /path/to/candidate/broker.mjs
MQTT_TEST_PORT=18883 MQTT_TEST_ITERATIONS=10000 node --heap-prof --heap-prof-dir=/path/to/profiles /path/to/candidate/broker.mjs
MQTT_TEST_PORT=18883 MQTT_TEST_ITERATIONS=10000 node --trace-opt --trace-deopt /path/to/candidate/broker.mjs > /path/to/profiles/v8.log
```

Use the CPU or allocation profile to pick a call site before investigating object shapes or type feedback in the V8 trace. Recheck a candidate with the profiler off and the same packet validation, byte ownership and ordering. Log the result under [#178](https://github.com/dvkam/mqtt/issues/178). Open a linked issue when a measured bottleneck needs its own change.

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
