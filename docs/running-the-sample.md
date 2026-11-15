# Running the sample

Build the package, start a local Mosquitto broker, then run `node sample/sample.ts` with the pinned development Node runtime. `MQTT_HOST` defaults to `127.0.0.1`. `MQTT_PORT` defaults to `1883`.

The example subscribes to `example/echo`, publishes `hello`, prints the echoed payload, sends a ping and disconnects. The echo wait has a five-second deadline. It uses an anonymous plaintext local connection.

Mosquitto remains the independent MQTT 5 integration broker under #23. Scripted peers provide exact packet and fault assertions.
