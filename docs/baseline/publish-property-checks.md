# PUBLISH property validation smoke observations

These observations come from the installed tarball built at product commit 83020bb676fd762d8fb8946e6d466fdf881c2198. Node 26.13.0 and native Mosquitto 2.0.18 ran on WSL2. The source mutations were restored before packing. The pinned hosted broker uses Mosquitto 2.0.22.

The existing packed TLS/WS script completed its MQTT exchanges, certificate rejection and proxy checks. These tiny loopback samples include broker and runtime scheduling. A formal replay ran concurrently. They are integration observations, not a controlled throughput comparison or reliable tail estimate.

| Session | Echoes | Echoes per second | Reported p99 ms |
| --- | ---: | ---: | ---: |
| TCP TLS | 5 | 2086.935035382 | 0.782715000 |
| TCP mutual TLS | 5 | 2651.803836524 | 0.495175000 |
| Node ws over WS | 5 | 1946.150028706 | 0.750579000 |
| Node ws over WSS | 5 | 2012.335617334 | 0.605117000 |
| Node ws over mutual WSS | 5 | 1785.317690142 | 0.704461000 |
| Node ws through WSS CONNECT proxy | 1 | 970.461104889 | 1.011191000 |

The first five rows contain five echo samples each. The proxy row contains one. No timing threshold or performance improvement is inferred. The per-PUBLISH walker now creates temporary functions and byte views. Allocation volume, throughput cost and bundle size were not measured in this local run; #18 and #118 retain that work.

Reproduce by building and packing the candidate, installing its tarball in a clean consumer, copying test/packed/broker.mjs into that consumer, and running bash test/packed/mosquitto-ws.sh "$consumer". The [broker guide](../packed-broker.md) documents native and pinned-container setup. The local runner is work/verify-mqtt-ws-session.sh and the output is work/publish-property-packed.log.

The scheduled browser matrix was not run locally. Portable-client comparisons in Vitest use Node's browser-compatible WebSocket API; they are not Chromium, Firefox or WebKit engine results.
