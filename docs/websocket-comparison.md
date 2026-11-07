# WebSocket comparison

The packed tests run CONNECT, SUBSCRIBE, a QoS 0 echo, PING and DISCONNECT against Mosquitto. The public Node createWebSocketClient uses ws and the library packet parser. The native Node and Chromium probes use the installed mqtt/websocket opening helper with a test-only MQTT exchange. The browser bundle check covers that helper and its test consumer.

| Check | Node ws client | Native Node 26 | Chromium |
|---|---|---|---|
| MQTT 5 over WS | Direct Mosquitto | Direct Mosquitto | Direct Mosquitto |
| MQTT 5 over WSS | Direct Mosquitto | HTTP/1.1-only TLS gateway to Mosquitto | HTTP/1.1-only TLS gateway to Mosquitto |
| Unknown CA and wrong hostname | Rejected | Rejected at gateway | Rejected at gateway with isolated profile |
| Client certificate | Direct mTLS passed, missing certificate rejected | Dispatcher certificate settings untested | Browser client certificate selection untested |
| HTTP CONNECT proxy | Per-client Node HTTPS agent | Process proxy configuration | Browser proxy configuration |
| Paused receiver | Reached admission limit and settled on peer close | Reached admission limit and settled on peer close | Reached admission limit and settled on peer close |

Node's direct native WSS attempt against the local Mosquitto 2.0.18 listener ended during the exchange and emitted the experimental HTTP/2 warning. The HTTP/1.1 gateway is a separate case. The result supports retaining ws for the public Node adapter. The proxy fixture verifies loopback routing. Proxy authentication and policy outside the fixture remain open.

The pressure probe sends 64 KiB messages with a 128 KiB local admission budget and pauses the receiver. In one local run, ws admitted 39 sends and reported a 65,550 byte peak. Native Node and Chromium each admitted two sends and reported a 131,072 byte peak. The peer closed all three after about 500 ms. These values describe each API's bufferedAmount and kernel progress. They do not measure broker receipt or total memory. The public client also tests local termination when a paused peer does not finish the close handshake.

Use the same MQTT bytes and failure schedules for callback, AsyncIterable and Web Streams measurements under #18. The production browser session and a reusable byte interface remain part of #8 and #37. Browser APIs have no Node stream drain or per-client TLS/proxy options.
