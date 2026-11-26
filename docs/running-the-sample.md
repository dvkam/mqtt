# Running the sample

Save this as `mosquitto-local.conf` and run `mosquitto -c mosquitto-local.conf` in a second terminal. The broker needs WebSocket support for the browser listener.

```conf
listener 1883 127.0.0.1
protocol mqtt
listener 18884 127.0.0.1
protocol websockets
allow_anonymous true
persistence false
```

Both listeners accept anonymous local connections. Use them for the sample. In a separate ESM project, install the preview tarball, copy `sample/sample.ts`, and run `node sample.ts` with Node 26. `MQTT_HOST` defaults to `127.0.0.1`. `MQTT_PORT` defaults to `1883`. From the checkout, `pnpm build` followed by `node sample/sample.ts` also works.

The example subscribes and publishes on `example/echo`. It checks the response within five seconds, sends a ping, and disconnects. After disconnect it prints `Received an echo on example/echo`.

Mosquitto remains the independent MQTT 5 integration broker under #23. Scripted peers provide exact packet and fault assertions. A second broker can be evaluated under #23 if an interoperability gap calls for one.
