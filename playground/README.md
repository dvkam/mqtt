# MQTT playground

A browser page for trying the packed client. It has two modes:

- **Scripted broker in the page.** A small broker runs inside the page through `createTransportClient` from `mqtt/portable`. It grants every subscription, acknowledges QoS 1, sends each publication back to matching subscriptions, and refuses the topic `playground/refused` with PUBACK reason 0x87. No server is needed.
- **Local broker over WebSocket.** The page connects with `createBrowserClient` from `mqtt/browser`. `mosquitto.conf` here starts a WebSocket listener on 127.0.0.1:18900.

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

`node playground/test/smoke.mjs` builds the page, checks that the bundle imports no Node built-in, serves it and drives both panels in Chromium. Set `MQTT_PLAYGROUND_WS_URL=ws://127.0.0.1:18900` to also run the steps against the broker. CI runs both modes in the `playground` job.

This is a proof of concept for #21. It does not cover QoS 2, durable sessions or browser page lifecycle events yet.
