# MQTT 5 client rewrite

This fork of [mqttjs-v5](https://github.com/mqttjs/mqttjs-v5) explores a TypeScript-first MQTT 5 client for new Node and browser applications. It builds on work from [MQTT.js](https://github.com/mqttjs/MQTT.js). The current preview supports a small, tested protocol profile; it is not yet a full MQTT.js replacement.

The package is ESM only. Node consumers are supported on Node 26, the current LTS line. Development uses the exact Node version in [.node-version](.node-version) and the pnpm version in [package.json](package.json).

## Try the preview

Use the downloadable `mqtt-tarball` artifact from a successful [CI run](https://github.com/dvkam/mqtt/actions), or build and pack this checkout. Install that tarball into a separate project. The current package name is `mqtt`; installing `mqtt` from the public registry does not install this fork. The publishing name and canary process remain under [#24](https://github.com/dvkam/mqtt/issues/24).

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack --pack-destination ./artifacts
```

In a separate directory, create an ESM project and install the tarball.

```sh
npm init -y
npm pkg set type=module
npm install /absolute/path/to/artifacts/mqtt-0.1.0.tgz
```

## Node TCP

Start a local MQTT 5 broker first. Save this as `echo.mjs` and run `node echo.mjs` in the project where you installed the tarball. A successful run prints `Received an echo on example/echo`. [Local broker setup](https://github.com/dvkam/mqtt/blob/main/docs/running-the-sample.md)

```js
import { createTcpClient } from 'mqtt';

const topic = 'example/echo';
let receive;
const client = await createTcpClient({
  host: process.env.MQTT_HOST ?? '127.0.0.1',
  port: Number(process.env.MQTT_PORT ?? 1883),
  clientId: 'readme-node',
  onMessage(message) {
    if (message.topic === topic && message.payload.toString() === 'hello') receive?.();
  },
}).connect().catch(() => {
  throw new Error('MQTT connection failed. Check the broker host, port, and access.');
});

let timer;
try {
  await client.subscribe(topic);
  const echo = new Promise((resolve, reject) => {
    receive = resolve;
    timer = setTimeout(() => reject(new Error('MQTT echo timed out')), 5000);
  });
  await Promise.all([echo, client.publish(topic, 'hello')]);
} finally {
  clearTimeout(timer);
  await client.disconnect();
}
console.log('Received an echo on example/echo');
```

The TypeScript sample uses the same installed import. Construction performs no I/O. The first `connect()` starts one attempt and later calls return its promise. Create a new factory to retry. Pass `username` and `password` for a broker that requires them. `password` is a string, sent as UTF-8, or a `Uint8Array`. [TypeScript sample](https://github.com/dvkam/mqtt/blob/main/sample/sample.ts) · [First connection and recovery](https://github.com/dvkam/mqtt/blob/main/docs/recipes/first-connection.md)

For authenticated TCP, pass a `tls` object with optional CA and client identity settings. The [TCP TLS guide](docs/tcp-tls.md) covers handshake ownership, certificate checks and mutual TLS.

TCP now defaults to a 1 MiB incoming packet limit. The [packet-input guide](docs/tcp-packet-input.md) defines configuration, compact Buffer ownership, EOF and failure behavior. Larger incoming packets need an explicit limit.

For Node WS/WSS, use `createWebSocketClient` from `mqtt/ws` with a broker URL. It needs the `ws` package, an optional peer dependency that you install yourself (`pnpm add ws`). Without `ws`, importing `mqtt/ws` fails with a module-not-found error, and every other entry works. The client accepts CA, client certificate and caller-supplied agent options. See the [transport comparison](docs/websocket-comparison.md) for TLS, proxy, backpressure and close behavior, including limitations of the experimental native Node WebSocket probe.

Node WS/WSS also defaults to a 1 MiB incoming MQTT packet limit. Set `maxPacketBytes` independently of the WebSocket-message limit. The [packet-input guide](docs/websocket-packet-input.md) covers fragmented input, compact Buffer ownership and failure outcomes.

Both WebSocket clients default to a message limit of twice the MQTT packet limit. With the default 1 MiB packet limit, this allows up to 2 MiB per incoming WebSocket message. Set `maxWebSocketMessageBytes` to an integer from 1 through 2,147,483,647 to change it. This includes coalesced MQTT packets in that message. The Node adapter enforces the limit through ws; the browser checks after native assembly. Each client also has a separate MQTT packet limit.

Both Node factories accept an optional signal for the connection attempt and active session. During an active session, abort rejects pending publish, subscribe and ping calls with the original Error reason, or an AbortError for a non-Error reason, and starts native teardown. Immediate later work is rejected too. Existing closing checks and established active-session failures keep precedence. Normal closure releases the signal listener. An application message facade's cancellation remains local to that facade; the connection signal owns the connection.

## Browser WebSocket

The broker must expose an MQTT WebSocket endpoint. The local configuration uses `ws://127.0.0.1:18884/mqtt` with an HTTP development page. Use `wss://` when the page is served over HTTPS. Browser TLS trust, client certificates and proxy settings belong to the browser. [Local broker setup](https://github.com/dvkam/mqtt/blob/main/docs/running-the-sample.md)

In the project where you installed the tarball, run `npm install -D vite`. Save the example as `echo.ts` and create an `index.html` containing `<script type="module" src="/echo.ts"></script>`. Run `npx vite` and open its local URL. The browser console prints `Received an echo on example/echo`.

```ts
import { createBrowserClient } from 'mqtt/browser';

const topic = 'example/echo';
let receive: (() => void) | undefined;
const text = new TextDecoder();
const client = await createBrowserClient({
  url: 'ws://127.0.0.1:18884/mqtt',
  clientId: 'readme-browser',
  onMessage(message) {
    if (message.topic === topic && text.decode(message.payload) === 'hello') receive?.();
  },
}).connect().catch(() => {
  throw new Error('MQTT connection failed. Check the broker WebSocket URL and access.');
});

let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await client.subscribe(topic);
  const echo = new Promise<void>((resolve, reject) => {
    receive = resolve;
    timer = setTimeout(() => reject(new Error('MQTT echo timed out')), 5000);
  });
  await Promise.all([echo, client.publish(topic, 'hello')]);
} finally {
  clearTimeout(timer);
  await client.disconnect();
}
console.log('Received an echo on example/echo');
```

See the [browser client profile](docs/browser-client.md) and the [byte transport core](docs/byte-transport.md) before using the preview against a broker.

## Supported profile and limits

The [deadline guide](docs/deadlines.md) defines timeout validation, captured settings and the limits of relative operation budgets.

The [outgoing admission guide](docs/outgoing-admission.md) defines publication count and wire-byte limits. Defaults allow 32 pending publications within 1 MiB. Capacity rejection occurs before sending and leaves the session usable.

Pass `{ qos: 1 }` to publish with broker acknowledgment. The [publishing guide](docs/qos1-publish.md) explains quota, shared identifiers and cancellation. To receive at QoS 1, configure `onQosOneMessage` and request QoS 1 when subscribing. See the [delivery guide](docs/qos1-receive.md) for the callback contract. Pass `{ qos: 2 }` to publish through PUBREC, PUBREL and PUBCOMP, and configure `onQosTwoMessage` to receive each QoS 2 message once. The [QoS 2 guide](docs/qos2.md) describes both directions.

Set `will` to register a message for the broker to publish if the connection is interrupted. Use `disconnect({ reasonCode: 4 })` to request that Will on a deliberate shutdown. [Will messages](https://github.com/dvkam/mqtt/blob/main/docs/will-message.md)

The [concurrent subscription guide](docs/concurrent-subscriptions.md) defines independent packet-ID correlation and count/encoded-byte admission. Defaults permit 32 pending subscriptions within 1 MiB. Subscriptions can complete in a different order while ping remains independent.

The [native write reserve](docs/native-write-reserve.md) checks observed queued bytes before each application send and preserves control admission room. TCP and WS/WSS default to a 1 MiB total with a 128 KiB control reserve. These settings preserve wire order and do not give control packets priority over queued data.

- The supported clients open MQTT 5 sessions with Keep Alive set to zero, a clean one by default. `cleanStart: false` with a `sessionExpiryInterval` and a `sessionState` resumes the broker session. [Reconnecting](docs/reconnect.md#resuming-the-session) They support ordinary QoS 0, 1 and 2 subscriptions, text and byte publishing at each QoS with retain and the MQTT 5 PUBLISH properties, received binary payloads, explicit ping and graceful disconnect. [Publishing](docs/publishing.md)
- A positive Server Keep Alive in CONNACK makes the client send pings when its outbound connection is idle. Manual and automatic pings share one PINGRESP exchange. A failed ping retires the connection because a later PINGRESP cannot identify which request it answers.
- Session rejections are `MqttError` values with a stable `code` and a `fatal` flag. MQTT reason codes are in `reasonCode`. The [error code guide](docs/errors.md) lists each code.
- Any operation timeout retires the session and starts forced cleanup. Later work cannot send. Already-admitted QoS 0 bytes may still reach the broker; a timeout does not prove non-delivery. The deadline guide explains custom transport cleanup requirements.
- Successful QoS 0 publication reports local send completion or admission according to the adapter. It does not prove broker receipt or durable storage.
- Publishing rejects empty topic names, wildcards, null characters, unpaired surrogates and names exceeding 65,535 UTF-8 bytes before sending. Rejection leaves an active session usable. Topic aliases are not supported by this publishing API.
- The browser transport has a write budget and the browser codec has a separate packet allocation limit. These are not a bound on every retained application object or an offline message queue.
- [Reconnecting](docs/reconnect.md) opens a new connection after a failure and reports QoS 1 and QoS 2 publications with an unknown outcome. With `resume`, it resumes the MQTT session and continues each unfinished QoS 1 and QoS 2 exchange with its Packet Identifier. Otherwise it makes the subscriptions again. In a browser, [`watchPageLifecycle`](docs/page-lifecycle.md) checks the connection when the page comes back from hiding, a freeze or the back-forward cache.
- A session state that survives a process restart (#14), configurable CONNECT Keep Alive, full authentication and the complete MQTT 5 property set remain planned work. The [codec profile](docs/codec.md) lists accepted packets and properties.
- The package has no `connect()` export. Create a client with `createTcpClient`, `createWebSocketClient` or `createBrowserClient`. The MQTT.js-style client that earlier previews kept for baseline comparisons was removed in #170.

## Entry points

| Import           | Purpose                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `mqtt`           | Node TCP client factory                                           |
| `mqtt/ws`        | Node WS/WSS client factory, which needs the optional peer `ws`    |
| `mqtt/browser`   | Browser MQTT client                                               |
| `mqtt/codec`     | Portable `Uint8Array` encoder and incremental decoder             |
| `mqtt/portable`  | Custom byte transport client with Uint8Array payloads              |
| `mqtt/websocket` | `WebSocketOptions` type                                           |

Use `createTransportClient` from `mqtt` for a custom byte transport with Buffer payloads. See the [custom transport guide](docs/recipes/using-custom-transports.md).

The browser client, the Node adapters and the shared session all use the in-repository portable codec and its packet types. The package has no runtime dependency. The Node WebSocket client in `mqtt/ws` needs `ws` as an optional peer dependency. `mqtt-packet` is a development dependency that the tests use as an independent reference. The remaining protocol profile is tracked in [#8](https://github.com/dvkam/mqtt/issues/8) and [#37](https://github.com/dvkam/mqtt/issues/37).

The [public type guide](docs/public-types.md) lists named options, factories, sessions and platform message types.

The [design decision record](docs/design-decisions.md) records decisions about the public API and the package layout, with the options weighed and the reason given for each.

## Development and evidence

Read the [contribution guide](.github/contributing.md). CI runs tests, strict compiler checks, type-aware lint, formatting and builds on Ubuntu and Windows. The packed-consumer job installs the actual tarball, checks declarations and browser bundles, and exercises MQTT 5 against Mosquitto over TCP and WS/WSS with certificate and proxy cases. Scheduled runs add browser runtime tests across Chromium, Firefox and WebKit. Wider browser and fault coverage remains work under [#23](https://github.com/dvkam/mqtt/issues/23).

The [verification guide](.agents/skills/verify-mqtt-lifecycle/SKILL.md) describes bounded lifecycle models and their limits. Models supplement regression and integration tests; they do not prove the entire implementation correct.

The [measurement index](docs/measurements.md) links workloads, individual observations, environments and reproduction commands. The [Node framing comparison](docs/node-framing-experiment.md) records why supported TCP and WS/WSS input use compact assembly. The streaming alternative remains test-only.

The [playground](https://github.com/dvkam/mqtt/issues/21), [human and agent API reference](https://github.com/dvkam/mqtt/issues/22), and remaining [documentation, attribution and conduct work](https://github.com/dvkam/mqtt/issues/48) are tracked separately. This preview has not settled its publishing identity.

## Credits

David Kaminski maintains this fork. It builds on the work of the mqttjs-v5 and MQTT.js contributors and Adam Rudd. The source headers and license retain the original notices. [mqttjs-v5 contributors](https://github.com/mqttjs/mqttjs-v5/graphs/contributors) · [MQTT.js contributors](https://github.com/mqttjs/MQTT.js/graphs/contributors) · [License](LICENSE.md)
