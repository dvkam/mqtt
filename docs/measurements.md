# Measurement records

Keep workload, environment, tool versions, individual observations, summary and reproduction commands with each experiment. State what the measurement excludes. Record changed validation or ownership rules before comparing speed. Raw profiler output stays in local research files or CI artifacts unless a checked-in fixture is needed to reproduce a regression.

| Work | Record | Scope |
| --- | --- | --- |
| Pinned upstream comparison | [Baseline data](baseline/results.jsonl) and [runner](baseline/measure.mjs) | Initial Node and browser reference workloads |
| Portable codec | [Codec measurements](codec.md#initial-measurements) | Encoding and decoding a 256-byte payload; three-run medians |
| Application consumption | [Queue comparison](message-stream-comparison.md) | Callback, iterator and Web Streams delivery; queue accounting and ownership |
| WebSocket transport | [WS/WSS comparison](websocket-comparison.md) | TLS, proxy, bufferedAmount admission and close observations |
| Receive-limit validation | [8 November observations](baseline/receive-validation-measurements.md) | Individual broker smoke timings, browser delivery and fixture bundle sizes |
| Bounded Node framing | [Individual measurements](baseline/node-framing-measurements.md) and [design](node-framing-experiment.md) | Compact assembly, streaming gate and native reference |
| Node parser occupancy | [Individual observations](baseline/node-framing-occupancy.md) | Native fragment bytes/items and compact assembly capacity; no allocation or timing claim |
| Mixed traffic preview | [Six observations](baseline/mixed-traffic-probe.md) and [method](mixed-traffic-probe.md) | QoS 0 bursts, capacity rejection, ping, subscriptions, delayed echoes and same-process metrics |
| Concurrent subscriptions | [CI observations](baseline/concurrent-subscriptions-checks.md) | Individual packed-broker echo timings and fixture bundle sizes; no controlled performance comparison |
| QoS 1 wire profile | [CI observations](baseline/qos1-wire-checks.md) | Packed QoS 0 echo timings and bundle sizes after expanding the codec |
| Outbound QoS 1 | [CI observations](baseline/qos1-outbound-checks.md) | Packed QoS 1 exchange validation, QoS 0 echo timings and fixture sizes |

The compact runner now uses the private production decoder described in [TCP packet input](tcp-packet-input.md) and [Node WebSocket packet input](websocket-packet-input.md). Historical prototype runs remain pinned in the measurement record. Decoder-only throughput excludes the input helper, session and native socket.

Local timing observations do not become CI thresholds automatically. #18 owns repeatable bundle, throughput, latency and memory baselines. #56 owns portable encoder allocation profiling. #75 owns the Node framing comparison and adoption decision. A passing protocol exchange or a small bundle does not establish a general performance advantage.

The [historical dependency removal observations](baseline/dependency-removal.md) preserve PR #59's installed-tree, bundle and broker checks, including the correction that the after tree came from an incremental update.
