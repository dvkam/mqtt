# <img src="media/header.png" title="MQTT.js" alt="MQTT.js logo" width="530">

**NOTE: Development on this repository is on hold. Please see [this issue](https://github.com/mqttjs/mqttjs-v5/issues/11) for more information.**

This is the development repository for the next generation of MQTT.js, an MQTT
client for JavaScript with a simple API, detailed error output, and modern
language features that lets you create cutting edge MQTT-based applications 🚀

### Experimental MQTT 5 exchange

The `mqtt/portable` entry point is a tracer for the rewrite. It completes CONNECT, one SUBSCRIBE at a time, QoS 0 publish and clean DISCONNECT. Supply a packet transport that handles framing and socket lifetime. The client rejects pending operations when the transport reports closure. The existing Node entry point remains `mqtt`.

The packed CI job installs the tarball in a clean consumer, checks declarations, runs a TCP echo against Mosquitto and records the portable browser bundle size. The scheduled browser test runs the same exchange and a close-before-drain fault with a scripted packet transport. Browser broker connections require a WebSocket adapter.
