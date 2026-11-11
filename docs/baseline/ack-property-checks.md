# ACK property validation smoke observations

The installed tarball was built at product commit 47748178c68d45883d8f08aeab01ae48a9426e14 after source mutations were restored. Node 26.13.0 and native Mosquitto 2.0.18 ran on WSL2. Hosted integration uses the pinned Mosquitto 2.0.22 image.

The packed script passed its MQTT exchanges, certificate rejection and proxy checks. Its echo timing follows the protocol assertions. These are tiny loopback integration observations, not a controlled throughput comparison or reliable tail estimate.

| Session | Echoes | Echoes per second | Reported p99 ms |
| --- | ---: | ---: | ---: |
| TCP TLS | 5 | 2469.813934097 | 0.569582000 |
| TCP mutual TLS | 5 | 2636.962514523 | 0.566700000 |
| Node ws over WS | 5 | 2876.452896358 | 0.473310000 |
| Node ws over WSS | 5 | 2673.099212612 | 0.561435000 |
| Node ws over mutual WSS | 5 | 2733.326299574 | 0.480786000 |
| Node ws through WSS CONNECT proxy | 1 | 1169.708298145 | 0.835779000 |

Five direct sessions contain five echoes each. The proxy session contains one. No timing threshold or performance advantage follows from these samples. Allocation volume and the cost of property checks remain unmeasured under #18 and #118.

Build and pack the candidate, install the tarball in a clean consumer, copy test/packed/broker.mjs into it, and run bash test/packed/mosquitto-ws.sh "$consumer". The [broker guide](../packed-broker.md) documents native and pinned-container setup. The local runner and log are work/verify-mqtt-ws-session.sh and work/ack-property-packed.log.

The scheduled browser matrix was not run locally. Portable-client unit comparisons use Node's browser-compatible WebSocket API and do not stand in for separate Chromium, Firefox or WebKit runs.
