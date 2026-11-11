# Property value smoke observations

The installed tarball used product source 202222f6a29ee9b77f1524690da0b8628f3caa57 after all deliberate source faults were restored. Node 26.13.0 and Mosquitto 2.0.18 ran on WSL2. Hosted integration uses the pinned Mosquitto 2.0.22 image.

All exchange, certificate rejection and proxy assertions passed. Each direct session contains five echoes. The proxy session contains one.

| Session | Echoes | Echoes per second | Reported p99 ms |
| --- | ---: | ---: | ---: |
| TCP TLS | 5 | 1881.301183150 | 0.737804000 |
| TCP mutual TLS | 5 | 2745.888855206 | 0.519499000 |
| Node ws over WS | 5 | 2498.600783561 | 0.650903000 |
| Node ws over WSS | 5 | 1836.335497026 | 0.765882000 |
| Node ws over mutual WSS | 5 | 2474.445167532 | 0.561766000 |
| Node ws through WSS CONNECT proxy | 1 | 447.313213185 | 2.196434000 |

These loopback samples do not measure validation throughput, allocation cost or tail latency. They support no performance comparison. The scheduled browser matrix was not run locally.

Build and pack the candidate, install its tarball into a clean consumer, copy test/packed/broker.mjs into it and run `bash test/packed/mosquitto-ws.sh "$consumer"`. The [broker guide](../packed-broker.md) documents setup. Raw output stays local at work/property-values-packed.log. Allocation profiling remains under #18/#118.
