# Base decision and extraction check

Use the existing fork as the repository. Use active MQTT.js at 0ceae419ff0542105fa258b3ae9760798db7b44d as the behavior reference. The pinned package completed the Node and Chromium QoS 0 tracer. Both original clients left a write pending when their transport closed before drain.

The experimental client in src/portable.ts implements the same MQTT 5 exchange using an injected packet transport. It owns CONNECT and SUBSCRIBE acknowledgment matching and the outcome of pending operations on transport closure. The TCP fixture in test/packed/broker.mjs owns socket I/O and uses mqtt-packet for framing. The browser fixture injects a scripted transport. Vite verifies the portable import has no Node shim or external runtime import.

No implementation code was copied from MQTT.js. The upstream commit records the behavior reference. The new client uses packet types from mqtt-packet and leaves packet encoding to the adapter. This verifies the exchange boundary for #3. #7 owns the supported TCP client, #8 owns browser WS/WSS, #11 owns queue admission and bounded outcomes, and #13 and #14 own QoS 2 and restart recovery.
