# Reconnecting

Each client factory opens one session. `createReconnectingClient` keeps a connection by building a fresh factory for each attempt. It is exported from `mqtt`, `mqtt/browser` and `mqtt/portable`.

```ts
import { createReconnectingClient, createTcpClient } from 'mqtt';

const client = createReconnectingClient(
  createTcpClient,
  { host: 'broker.example', clientId: 'sensor-7', onMessage: (message) => console.log(message.topic) },
  {
    subscriptions: [{ topic: 'commands/sensor-7/#', qos: 0 }],
    onReconnect(event) {
      if (event.kind === 'connected' && event.previous?.kind === 'error') {
        for (const lost of event.previous.uncertain ?? []) console.warn('Outcome unknown', lost.topic, lost.messageId);
      }
    },
  },
);

const session = await client.session();
await session.publish('telemetry/sensor-7', '21.5');
await client.disconnect();
```

The first argument can be `createTcpClient`, `createWebSocketClient`, `createBrowserClient` or a function such as `(options) => createTransportClient(transport, options)`. The client passes the options to it on every attempt. It replaces `onSessionEnd` and `signal` with its own, and calls the `onSessionEnd` you set as well.

## Sessions

Every attempt opens a clean session, because the client does not yet resume one. After each CONNACK, the client makes the `subscriptions` in order, then resolves `session()` and reports a `connected` event. A refused SUBACK does not end the session. Its error is listed in the event's `subscriptions`.

`session()` returns the same promise until that session ends. After an end, it returns the promise of the next session. A session object stays tied to its connection: once it ends, its calls reject with its error, so call `session()` again. Calls made while the client waits are not queued.

## Lost publications

When a session ends, every pending publish rejects with the session's error. A QoS 1 publication that was written but not acknowledged may or may not have reached the broker. The next `connected` event lists it in `previous.uncertain` with its topic, Packet Identifier and whether its PUBACK arrived before the write settled. The client never sends it again. A publication that was still queued was never written and is not listed. `onSessionEnd` receives the same `uncertain` list.

## Retries

The delay before attempt `n + 1` is drawn from half to all of `min(maxDelayMs, initialDelayMs × 2^(n − 1))`. The defaults are 1,000 and 30,000 milliseconds. One timer runs at a time. A session that stays up for `stableAfterMs`, which defaults to `maxDelayMs`, resets the count.

| Outcome | Next step |
| --- | --- |
| `ERR_MQTT_TRANSPORT`, `ERR_MQTT_TIMEOUT` or an error that is not an `MqttError` | Retry |
| CONNACK Server unavailable (0x88), Server busy (0x89), Quota exceeded (0x97) or Connection rate exceeded (0x9F) | Retry |
| Any other CONNACK refusal | Stop with reason `refused` |
| Broker DISCONNECT Malformed Packet (0x81), Protocol Error (0x82), Not authorized (0x87), Session taken over (0x8E), Use another server (0x9C) or Server moved (0x9D) | Stop with reason `fatal` |
| Any other broker DISCONNECT | Retry |
| Any other `MqttError` code, such as `ERR_MQTT_PROTOCOL` or `ERR_MQTT_INVALID_ARGUMENT`, or a `RangeError` from the options | Stop with reason `fatal` |
| `maxAttempts` consecutive failures, 10 by default | Stop with reason `exhausted` |
| `client.disconnect()` or `disconnect()` on the session | Stop with reason `disconnect` |
| The `signal` in the options aborts | Stop with reason `aborted` |

After a stop, `session()` rejects with the error that caused it, or with `ERR_MQTT_CLOSING` after a disconnect. An abort reason that is an Error is passed through unchanged. `client.disconnect()` clears the timer, abandons an attempt that is opening, and disconnects a connected session with the options you pass.

In Node, the retry timer keeps the process alive until the client connects or stops.

## Not covered yet

- Resuming a session with Clean Start false and a Session Expiry Interval, tracked in #14. Until then, the broker forgets the subscriptions and queued messages of each session.
- A smaller packet limit or a Topic Alias map on resume, tracked in #12.
- Page lifecycle events in the browser, such as a page restored from the back-forward cache, tracked in #32.
- Server Reference redirects, tracked in #16.
