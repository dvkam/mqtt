# Connection agreement smoke observations

The installed tarball used product source ae0794cb9be8413fff68503e5921b5f1b0640974 after every deliberate source fault was restored. Node 26.13.0 and Mosquitto 2.0.18 ran on WSL2. Hosted integration uses the pinned Mosquitto 2.0.22 image.

All installed exchange, certificate-rejection and proxy checks passed. The scripted regression peers separately verify empty-ID assignments and authentication violations. The packed broker fixtures use named IDs. These loopback observations do not measure authentication-validation throughput or allocation cost.

| Session | Echoes | Echoes per second | Reported p99 ms |
| --- | ---: | ---: | ---: |
| TCP TLS | 5 | 1832.934608958 | 0.869461000 |
| TCP mutual TLS | 5 | 2111.822701503 | 0.663595000 |
| Node ws over WS | 5 | 2494.442382372 | 0.506112000 |
| Node ws over WSS | 5 | 1630.596247085 | 0.949248000 |
| Node ws over mutual WSS | 5 | 1722.069072879 | 0.631849000 |
| Node ws through WSS CONNECT proxy | 1 | 844.405601787 | 1.159442000 |

Each direct session has five echoes. The proxy has one. These samples support no tail-latency or performance comparison. The scheduled browser matrix was not run locally. Browser-adapter regressions use the native WebSocket client in Node, not a browser engine.

Build and pack the candidate, install the tarball in a clean consumer, copy test/packed/broker.mjs into it and run `bash test/packed/mosquitto-ws.sh "$consumer"`. The [broker guide](../packed-broker.md) documents setup. Raw output remains local at work/agreement-packed.log. Broader performance work stays under #18/#118.
