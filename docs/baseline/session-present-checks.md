# Session Present smoke observations

The installed tarball used product source 3a26916b737e4936b36dada89df63d32103645e1 after all deliberate source faults were restored. Node 26.13.0 and Mosquitto 2.0.18 ran on WSL2. Hosted integration uses the pinned Mosquitto 2.0.22 image.

The supported adapter exchanges, certificate-rejection controls and proxy assertions passed. These broker sessions use named IDs, Clean Start true and Session Present false. Scripted peers separately exercise contradictory Session Present responses.

| Session | Echoes | Echoes per second | Reported p99 ms |
| --- | ---: | ---: | ---: |
| TCP TLS | 5 | 1930.411745243 | 0.686734000 |
| TCP mutual TLS | 5 | 2230.842196469 | 0.585788000 |
| Node ws over WS | 5 | 2574.121838335 | 0.497244000 |
| Node ws over WSS | 5 | 2143.043893825 | 0.518130000 |
| Node ws over mutual WSS | 5 | 1752.908601242 | 0.727063000 |
| Node ws through WSS CONNECT proxy | 1 | 706.433204621 | 1.388483000 |

Each direct session has five echoes. The proxy has one. These samples establish no tail-latency, throughput or allocation advantage. The scheduled browser engine matrix was not run locally. The public browser-adapter regressions use the native WebSocket client in Node.

The separate native WebSocket direct-WSS attempt did not complete and emitted the known experimental HTTP/2 warning. The harness checked that outcome and the HTTP/1.1 gateway case passed. The [WebSocket comparison](../websocket-comparison.md) records this limitation. The public Node WebSocket adapter continues using ws.

Build and pack the candidate, install the tarball in a clean consumer, copy test/packed/broker.mjs into it and run `bash test/packed/mosquitto-ws.sh "$consumer"`. The [broker guide](../packed-broker.md) documents setup. Raw output stays local at work/clean-start-packed.log. Broader performance work remains under #18/#118.
