# DISCONNECT property smoke observations

The installed tarball was built at source 622bc0ec5c2c8e04a6c475b0f0efb1fef89376db after all source faults were restored. Node 26.13.0 and Mosquitto 2.0.18 ran on WSL2. Hosted integration uses the pinned Mosquitto 2.0.22 image.

All packed exchange, certificate rejection and proxy checks passed. These tiny loopback observations follow protocol assertions and do not measure property-validation throughput or allocation cost.

| Session | Echoes | Echoes per second | Reported p99 ms |
| --- | ---: | ---: | ---: |
| TCP TLS | 5 | 2014.871362553 | 0.671411000 |
| TCP mutual TLS | 5 | 1756.844931379 | 0.780585000 |
| Node ws over WS | 5 | 1575.971602253 | 1.159926000 |
| Node ws over WSS | 5 | 1273.103000144 | 1.155168000 |
| Node ws over mutual WSS | 5 | 1878.310992702 | 0.639972000 |
| Node ws through WSS CONNECT proxy | 1 | 1311.797122704 | 0.750108000 |

Five direct sessions contain five echoes each. The proxy sample contains one. No tail-latency or performance advantage follows from these samples. The scheduled browser matrix was not run locally.

Build and pack the candidate, install its tarball in a clean consumer, copy test/packed/broker.mjs into it, and run bash test/packed/mosquitto-ws.sh "$consumer". The [broker guide](../packed-broker.md) documents native and pinned-container setup. Raw output is local at work/disconnect-property-packed.log. Allocation work remains under #18/#118.
