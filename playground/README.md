# MQTT playground

A browser page for trying the packed client. It has two modes:

- **Scripted broker in the page.** A small broker runs inside the page through `createTransportClient` from `mqtt/portable`. It grants every subscription, acknowledges QoS 1, sends each publication back to matching subscriptions, and refuses the topic `playground/refused` with PUBACK reason 0x87. It never acknowledges `playground/unacknowledged`. No server is needed.
- **Local broker over WebSocket.** The page connects with `createBrowserClient` from `mqtt/browser`. `mosquitto.conf` here starts a WebSocket listener on 127.0.0.1:18900.

Both modes connect through `createReconnectingClient`. The reconnect panel lists each `connected` event with its generation, attempt and the end of the previous session, including the QoS 1 publications whose outcome is unknown, each `retrying` event with its delay and error, and the `stopped` event. In scripted mode, "Drop connection" ends the broker's connection, and the client opens a new session after the backoff. Each attempt opens a clean session, so the page subscribes again to the filters it subscribed before. Publish to `playground/unacknowledged` at QoS 1 and then drop the connection to see an uncertain publication.

The panels show the CONNACK result, subscription results, QoS 0 and 1 publishing, a drained disconnect or one that asks for the Will, the stable error code of each rejection, and the client's diagnostics. Diagnostics hold packet commands and connection states, never topics, payloads or credentials. The page stores nothing. A user name and password stay in the form fields until the page closes.

## Run it

From the repository root:

```sh
pnpm install
pnpm build
pnpm pack --pack-destination playground
npm install --prefix playground --no-save ./playground/mqtt-*.tgz
pnpm exec vite playground
```

For the broker mode, start Mosquitto in another terminal with `mosquitto -c playground/mosquitto.conf`, choose "Local broker over WebSocket" and connect.

## Check it

`node playground/test/smoke.mjs` builds the page, checks that the bundle imports no Node built-in, serves it and drives both modes in Chromium. In scripted mode it also drops the connection with a QoS 1 publication in flight, waits for the second session, checks that the publication is listed as uncertain, and receives a message after the page subscribed again. Set `MQTT_PLAYGROUND_WS_URL=ws://127.0.0.1:18900` to also run the steps against the broker. CI runs both modes in the `playground` job.

This is a proof of concept for #21. It does not cover QoS 2, durable sessions or browser page lifecycle events yet. A "Retry now" control and the page lifecycle adapter need `retryNow()` and `watchPageLifecycle` from #195, and the page can use them once that is merged.
