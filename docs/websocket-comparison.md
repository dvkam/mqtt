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

## Receive limits

Both public WebSocket clients accept `maxWebSocketMessageBytes`. It defaults to 1,048,576 bytes and must be an integer from 1 through 2,147,483,647. An exact-limit message is accepted. The Node adapter now overrides ws's larger default, so applications sending larger coalesced batches must configure this option explicitly.

Node passes the value to ws as `maxPayload`, which checks the complete WebSocket message during assembly. WebSocket protocol fragments share one limit. A rejected message never reaches the MQTT parser. The adapter preserves the native RangeError with code `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`, rejects pending operations and terminates locally even when the peer stalls its close handshake. Later operations retain the established failure. The browser checks after native assembly and reports its own RangeError; it cannot provide Node's earlier allocation guard or force termination.

This is independent of MQTT packet boundaries. Several MQTT packets in one WebSocket message share the budget. One MQTT packet split across several WebSocket messages can exceed it in total. The Node parser does not yet have the browser codec's `maxPacketBytes` guard. [#75](https://github.com/dvkam/mqtt/issues/75) tracks bounded Node framing before that gap is closed. Neither adapter claims a total-memory or network-backpressure bound.
