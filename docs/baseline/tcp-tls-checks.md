# TCP TLS fixture observations

Measured on 11 November 2026 from product source 9beac33 with the later test-only narrowing at d69a616. Local runs used Node 26.13.0, TypeScript 7.1 beta and native Mosquitto 2.0.18 on WSL2. Required CI uses the pinned Mosquitto 2.0.22 container. Run the existing packed broker script after installing the tarball, as described in the [broker guide](../packed-broker.md).

Each new TLS session verifies subscriptions, concurrent outbound QoS 1, held inbound QoS 1, ordered echoes and active cancellation. The five timed echoes occur after those protocol checks. The observations include TLS and MQTT work and the peer's scheduling. They are smoke observations without a controlled throughput comparison.

| Session             | Echoes |  Echoes per second |        p99 echo ms |
| ------------------- | -----: | -----------------: | -----------------: |
| TLS with private CA |      5 | 116.27781775279955 | 41.381602000000015 |
| Mutual TLS          |      5 | 116.21784458527002 |  41.56998899999999 |

The script also rejects an unknown authority, wrong hostname and missing client identity. The unchanged callback browser fixture was 21,563 minified bytes and 5,917 gzip bytes in this run. Raw output remains local in work/tcp-tls-broker-green.log and work/tcp-tls-packed.log.

The roughly 41 ms echo timing needs a separate socket-delay experiment under #18 before it can support a performance claim. The browser comparison and larger retention workloads remain in #118.
