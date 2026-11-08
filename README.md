# MQTT 5 client rewrite

This fork of [mqttjs-v5](https://github.com/mqttjs/mqttjs-v5) explores a TypeScript-first MQTT 5 client for new Node and browser applications. It builds on work from [MQTT.js](https://github.com/mqttjs/MQTT.js). The current preview supports a small, tested protocol profile; it is not yet a full MQTT.js replacement.

The package is ESM only. Node consumers are supported on Node 22.12+, 24 and 26 within those major versions. Development uses the exact Node version in [.node-version](.node-version) and the pnpm version in [package.json](package.json).

## Try the preview

Use the downloadable `mqtt-tarball` artifact from a successful [CI run](https://github.com/dvkam/mqtt/actions), or build and pack this checkout. Install that tarball into a separate project. The current package name is `mqtt`; installing `mqtt` from the public registry does not install this fork. The publishing name and canary process remain under [#24](https://github.com/dvkam/mqtt/issues/24).

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack --pack-destination ./artifacts
# In a separate ESM project:
pnpm add /absolute/path/to/artifacts/mqtt-5.0.0.tgz
```

## Node TCP

Start a local MQTT 5 broker before running this example. Construction performs no I/O; `connect()` starts one attempt. Repeated calls on the same factory return the same promise. Create another factory for a new attempt.

```ts
import { createTcpClient } from 'mqtt';

const client = await createTcpClient({
  host: '127.0.0.1',
  port: 1883,
  clientId: 'readme-node',
  maxPacketBytes: 1024 * 1024,
}).connect();

try {
  await client.subscribe('example/reply');
  await client.publish('example/request', 'hello');
  await client.ping();
} finally {
  await client.disconnect();
}
```

The runnable [TypeScript sample](sample/sample.ts) also receives an echoed message and bounds its wait. See its [broker instructions](docs/legacy-fixture-migration.md#run-the-example).

TCP now defaults to a 1 MiB incoming packet limit. The [packet-input guide](docs/tcp-packet-input.md) defines configuration, compact Buffer ownership, EOF and failure behavior. Larger incoming packets need an explicit limit.

For Node WS/WSS, use `createWebSocketClient` from `mqtt` with a broker URL. This adapter uses `ws` and accepts CA, client certificate and caller-supplied agent options. See the [transport comparison](docs/websocket-comparison.md) for TLS, proxy, backpressure and close behavior, including limitations of the experimental native Node WebSocket probe.

Node WS/WSS also defaults to a 1 MiB incoming MQTT packet limit. Set `maxPacketBytes` independently of the WebSocket-message limit. The [packet-input guide](docs/websocket-packet-input.md) covers fragmented input, compact Buffer ownership and failure outcomes.

Both WebSocket clients default to a 1 MiB limit per incoming WebSocket message. Set `maxWebSocketMessageBytes` to an integer from 1 through 2,147,483,647 to change it. This includes coalesced MQTT packets in that message. The Node adapter enforces the limit through ws; the browser checks after native assembly. Each client also has a separate MQTT packet limit.

Both Node factories accept an optional signal for the connection attempt and active session. During an active session, abort rejects pending publish, subscribe and ping calls with the original Error reason, or an AbortError for a non-Error reason, and starts native teardown. Immediate later work is rejected too. Existing closing checks and established active-session failures keep precedence. Normal closure releases the signal listener. An application message facade's cancellation remains local to that facade; the connection signal owns the connection.

## Browser WebSocket

The broker must expose an MQTT WebSocket endpoint. Browser TLS trust, client certificates and proxy settings belong to the browser.

```ts
import { createBrowserClient } from 'mqtt/browser';

const client = await createBrowserClient({
  url: 'wss://broker.example/mqtt',
  clientId: 'readme-browser',
  maxBufferedBytes: 1024 * 1024,
  maxPacketBytes: 1024 * 1024,
  onMessage(message) {
    console.log(message.topic, message.payload.byteLength);
  },
}).connect();

try {
  await client.subscribe('example/reply');
  await client.publish('example/request', 'hello');
  await client.ping();
} finally {
  await client.disconnect();
}
```

See the [browser client profile](docs/browser-client.md) and [byte transport contract](docs/browser-transport.md) before using the preview against a broker.

## Supported profile and limits

- The supported clients open MQTT 5 clean sessions with Keep Alive set to zero. They support ordinary QoS 0 subscriptions, text publishing, received binary payloads, explicit ping and graceful disconnect.
- Await subscribe and ping operations before starting another acknowledgment exchange. A failed ping retires the connection because a later PINGRESP cannot identify which request it answers.
- Successful QoS 0 publication reports local send completion or admission according to the adapter. It does not prove broker receipt or durable storage.
- The browser transport has a write budget and the browser codec has a separate packet allocation limit. These are not a bound on every retained application object or an offline message queue.
- QoS 1/2, reconnect, durable sessions, automatic keepalive scheduling, full authentication and the complete MQTT 5 property set remain planned work. The [codec profile](docs/codec.md) lists accepted packets and properties; it can reject valid MQTT 5 features outside that profile.
- The legacy `connect()` export remains for baseline comparisons. Its [retained option types](docs/legacy-options.md) do not imply implementation of all historical MQTT.js features.

## Entry points

| Import | Purpose |
| --- | --- |
| `mqtt` | Node TCP and WS/WSS client factories; retained legacy `connect()` |
| `mqtt/browser` | Browser MQTT client and native browser byte transport |
| `mqtt/codec` | Portable `Uint8Array` encoder and incremental decoder |
| `mqtt/portable` | Packet-transport session tracer for adapter work |
| `mqtt/websocket` | Experimental native WebSocket transport probe |

The browser path uses the in-repository portable codec. The Node adapters still use `mqtt-packet`. Their convergence and the remaining protocol profile are tracked in [#8](https://github.com/dvkam/mqtt/issues/8) and [#37](https://github.com/dvkam/mqtt/issues/37).

The [public type guide](docs/public-types.md) lists named options, factories, sessions and platform message types.

## Development and evidence

Read the [contribution guide](.github/contributing.md). CI runs tests, strict compiler checks, type-aware lint, formatting and builds on Ubuntu and Windows. The packed-consumer job installs the actual tarball, checks declarations and browser bundles, and exercises MQTT 5 against Mosquitto over TCP and WS/WSS with certificate and proxy cases. Scheduled runs add browser runtime tests across Chromium, Firefox and WebKit. Wider browser and fault coverage remains work under [#23](https://github.com/dvkam/mqtt/issues/23).

The [verification guide](.agents/skills/verify-mqtt-lifecycle/SKILL.md) describes bounded lifecycle models and their limits. Models supplement regression and integration tests; they do not prove the entire implementation correct.

The [measurement index](docs/measurements.md) links workloads, individual observations, environments and reproduction commands. The [Node framing comparison](docs/node-framing-experiment.md) records why supported TCP and WS/WSS input use compact assembly. The streaming alternative remains test-only.

The [playground](https://github.com/dvkam/mqtt/issues/21), [human and agent API reference](https://github.com/dvkam/mqtt/issues/22), and remaining [documentation, license and conduct work](https://github.com/dvkam/mqtt/issues/48) are tracked separately. Upstream attribution remains in source headers. This preview has not settled its publishing identity.
