# Duplicate CONNACK smoke observations

The installed tarball used product source aabd859cd5e11f58483e2b1930985f7be05ec789 after all deliberate source faults were restored. Node 26.13.0 and Mosquitto 2.0.18 ran on WSL2. Hosted integration uses the pinned Mosquitto 2.0.22 image.

Supported TLS, mutual TLS, WS, WSS, certificate-rejection and proxy assertions passed. These broker sessions use a single valid CONNACK. Scripted peers separately exercise duplicate responses, including fragmented WebSocket messages.

| Session | Echoes | Echoes per second | Reported p99 ms |
| --- | ---: | ---: | ---: |
| TCP TLS | 5 | 2430.243505539 | 0.769664000 |
| TCP mutual TLS | 5 | 2723.562245109 | 0.539886000 |
| Node ws over WS | 5 | 2327.452017249 | 0.663391000 |
| Node ws over WSS | 5 | 2187.542383634 | 0.758190000 |
| Node ws over mutual WSS | 5 | 1599.241064161 | 0.800640000 |
| Node ws through WSS CONNECT proxy | 1 | 471.900674346 | 2.093102000 |

Each direct session has five echoes. The proxy has one. These small samples establish no tail-latency, throughput or allocation advantage. The scheduled browser-engine matrix was not run locally. Browser-adapter regressions use the native WebSocket client in Node.

The separate native direct-WSS attempt reproduced its known failed exchange and experimental HTTP/2 warning. The harness checked that outcome and the HTTP/1.1 gateway passed. The [WebSocket comparison](../websocket-comparison.md) records the limitation. The public Node WebSocket adapter continues using ws.

Build and pack the candidate, install the tarball in a clean consumer, copy test/packed/broker.mjs into it and run `bash test/packed/mosquitto-ws.sh "$consumer"`. The [broker guide](../packed-broker.md) documents setup. Raw output stays local at work/duplicate-connack-packed.log. Broader performance work remains under #18/#118.
