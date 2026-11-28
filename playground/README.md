# MQTT playground

A browser page for trying the packed client. It has two modes:

- **Scripted broker in the page.** A small broker runs inside the page through `createTransportClient` from `mqtt/portable`. No server is needed. It grants every subscription, acknowledges QoS 1 and sends each publication to the subscriptions it matches. It keeps retained messages until the page closes and publishes the Will when a connection ends without a normal DISCONNECT. It refuses the topic `playground/refused` with PUBACK reason 0x87 and never acknowledges `playground/unacknowledged`.
- **Local broker over WebSocket.** The page connects with `createBrowserClient` from `mqtt/browser`. `mosquitto.conf` here starts a WebSocket listener on 127.0.0.1:18900.

Working: connect over WebSocket, text password, a retained Will, subscribe at QoS 0 and 1, publish text at QoS 0 and 1 with retain, reconnect after a lost connection, a check when the page comes back, drained disconnect and stable error codes. Not yet: QoS 2. The client can also resume a session with `resume`, as [the reconnect guide](../docs/reconnect.md#resuming-the-session) describes. This page does not use it, so each connection starts a new session and the page subscribes again to the filters it subscribed before.

## Panels

- **Connection.** The status line shows the state of the connection. After a failure it names the likely cause and what to do, and a button beside it does that: "Retry now" while the client waits, "Connect again" after it stopped, or "Use ws://..." for a URL that starts with `http://`. The page sends the Will with the payload "offline" and retain, so a subscription made after the connection ended still receives it.
- **Subscribe and publish.** Results show each grant, each QoS 0 or QoS 1 outcome and each rejection with its stable code, reason code and `fatal` flag. A message that arrives for a new subscription from the broker's store is marked "retained".
- **Disconnect.** A disconnect can wait for the QoS 1 acknowledgments, and it can ask the broker to publish the Will.
- **Reconnect.** Both modes connect through `createReconnectingClient`. The list shows each `connected` event with its generation, attempt and the end of the previous session, including the QoS 1 publications whose outcome is unknown, each `retrying` event with its delay, error and recovery, and the `stopped` event. In scripted mode, "Drop connection" ends the broker's connection. The first retry waits 2.5 to 5 seconds. "Retry now" calls `retryNow()` and lists what it returned: true when it started the attempt at once, false while a session is connected or an attempt opens. The page also runs `watchPageLifecycle`, and the list shows each return of the page with its trigger, the time away and the outcome of the check. Publish to `playground/unacknowledged` at QoS 1 and then drop the connection to see an uncertain publication.
- **Diagnostics.** The client's diagnostics hold packet commands and connection states, never topics, payloads or credentials.

Each list is a `log` region that a screen reader announces and the keyboard can scroll. The focus moves to "Disconnect" when "Connect" becomes unavailable, and back.

The page keeps the mode, the URL, the client identifier, the Will topic, the filter, the topic and the QoS choices in `sessionStorage`, so a reload restores them. It never stores the user name, the password or the payload, and it stores no URL that carries credentials or a query. The user name and the password stay in their form fields until the page reloads or closes.

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

```sh
pnpm exec tsc -p playground/tsconfig.json
pnpm lint:playground
node --test playground/test/scripted.test.mjs
node playground/test/smoke.mjs
```

`scripted.test.mjs` drives the scripted broker through its byte transport. It checks topic matching, the Packet Identifier after 65,535 deliveries, the delivered QoS, retained messages and the Will.

`smoke.mjs` builds the page, fails when Vite reports an import of a Node built-in, serves the build and drives it in Chromium. Set `MQTT_PLAYGROUND_WS_URL=ws://127.0.0.1:18900` to run the same steps against the broker too. In each mode it checks the `log` and `status` roles, the focus after "Connect" and "Disconnect", QoS 0 and 1, a retained message and its removal, "Retry now" while connected, a page return, an invalid topic that leaves the session usable, the contrast of the result colors in the light and the dark scheme, and that a reload restores the nonsecret fields. It dispatches the visibility events with a replaced `document.visibilityState` getter, because a headless page stays visible. In scripted mode it connects with a user name and a password and checks that the page neither shows nor stores them. It then drops the connection with a QoS 1 publication in flight, uses the recovery button, and checks that the second session connects within 2 seconds, lists the publication as uncertain and receives the retained Will. A last run enters an `http://` URL, takes the suggested `ws://` URL and checks the recovery text after the failed handshake. CI runs all four commands in the `playground` job.

This is a proof of concept for #21. A real back-forward cache restore is covered for the client by `test/packed/page-lifecycle.ts`, not for this page.
