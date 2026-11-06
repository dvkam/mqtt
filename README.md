# <img src="media/header.png" title="MQTT.js" alt="MQTT.js logo" width="530">

**NOTE: Development on this repository is on hold. Please see [this issue](https://github.com/mqttjs/mqttjs-v5/issues/11) for more information.**

This is the development repository for the next generation of MQTT.js, an MQTT
client for JavaScript with a simple API, detailed error output, and modern
language features that lets you create cutting edge MQTT-based applications 🚀

### Experimental MQTT 5 exchange

The `mqtt/portable` entry point is a tracer for the rewrite. It completes CONNECT, one SUBSCRIBE at a time, QoS 0 publish and clean DISCONNECT. Supply a packet transport that handles framing and socket lifetime. The client rejects pending operations when the transport reports closure. The existing Node entry point remains `mqtt`.

The packed CI job installs the tarball in a clean consumer, checks declarations, runs a TCP echo against Mosquitto and records the portable browser bundle size. The scheduled browser test runs the same exchange and a close-before-drain fault with a scripted packet transport. Browser broker connections require a WebSocket adapter.

The Node entry point exports `createTcpClient({ host, port, clientId, signal })`. Construction performs no I/O. Call `connect()` to start one connection attempt, then use the connected client's `subscribe()`, `publish()`, `ping()` and `disconnect()` methods. Create a new client for a new connection attempt. The signal can cancel TCP setup or the MQTT handshake. The client removes its abort listener when the attempt settles.

`ping()` sends one PINGREQ and waits for PINGRESP. Await pending subscribe or ping calls before starting another acknowledgment exchange. A failed ping closes the connection because a late PINGRESP cannot be matched to a particular request.

The experimental mqtt/websocket subpath opens a native WebSocket in Node 26 or a browser. It requests the mqtt subprotocol and uses ArrayBuffer for binary frames. The signal and timeout cover the opening handshake. The returned socket has native send, buffering and close semantics. This probe tests the transport before MQTT session integration.

Node consumers use an active or maintenance LTS line supported by this package. The current range covers Node 22.12+, 24 and 26. Development and CI use the exact version in .node-version. The package manager version is pinned separately.

The Node entry point exports createWebSocketClient for MQTT 5 over WS and WSS. It uses ws, supports CA and client certificate options and a caller-supplied agent, and rejects writes that exceed the local buffered-byte budget. The send callback reports local write completion. Broker receipt is verified separately.
