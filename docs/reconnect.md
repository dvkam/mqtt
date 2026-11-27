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

The first argument can be `createTcpClient`, `createWebSocketClient`, `createBrowserClient` or a function such as `(options) => createTransportClient(transport, options)`. The client passes the options to it on every attempt. It replaces `onSessionEnd` and `signal` with its own. It calls the `onSessionEnd` you set after it has handled each session end. Each attempt receives `AbortSignal.any` of the `signal` you set and the client's own signal. An invalid number in the reconnect options throws a `RangeError` from `createReconnectingClient` itself.

## Sessions

Without `resume`, every attempt sends the factory's `cleanStart` flag, which defaults to true. With true, each attempt opens a new broker session. False needs a `sessionState` in the factory options. After each CONNACK with Session Present false, the client makes the `subscriptions` in order, then resolves `session()` and reports a `connected` event. A refused SUBACK does not end the session. Its error is listed in the event's `subscriptions`. After a CONNACK with Session Present true, the broker still has the subscriptions, so the client makes none and `subscriptions` is empty. The event's `resumed` field holds the Session Present flag.

The event's `generation` counts the sessions that connected, starting at 1. A failed attempt does not count. Its `attempt` counts the attempts since the last stable session, including the one that connected.

`session()` returns the same promise until that session ends. After an end, it returns the promise of the next session. A session object stays tied to its connection. Once the session ends, its calls reject with its error, so call `session()` again. Calls made while the client waits are not queued.

## Lost publications

When a session ends, every pending publish rejects with the session's error. A QoS 1 publication that was written but not acknowledged may or may not have reached the broker. The next `connected` event lists it in `previous.uncertain` with its topic and Packet Identifier. Its `acknowledged` field is true when a PUBACK with a reason below 0x80 arrived before the write settled, and only then is it known that the broker has the message. Without `resume`, the client never sends it again. A publication that was still queued was never written and is not listed. `onSessionEnd` receives the same `uncertain` list.

`previous` is the end of the session reported by the previous `connected` event. Failed attempts in between do not replace it, so a publication lost before a refused CONNACK is still listed once a session connects.

## Resuming the session

Set `resume: true` and a `sessionExpiryInterval` of at least 1 second in the factory options to keep one MQTT session across connections.

```ts
const client = createReconnectingClient(
  createTcpClient,
  { host: 'broker.example', clientId: 'sensor-7', sessionExpiryInterval: 3600, onQosOneMessage: handle },
  {
    resume: true,
    subscriptions: [{ topic: 'commands/sensor-7/#', qos: 1 }],
    onReconnect(event) {
      if (event.kind === 'connected' && !event.resumed) for (const lost of event.dropped ?? []) console.warn('Dropped', lost.topic);
      if (event.kind === 'puback' && event.reasonCode >= 0x80) console.warn('Refused', event.topic, event.reasonCode);
    },
  },
);
```

The first attempt sends the factory's `cleanStart` flag, true by default. Once a session has connected, every later attempt sends Clean Start false. All attempts share one session state, which holds each QoS 1 publication from its first write until its PUBACK arrives. The client copies the payload and the Correlation Data into the state, so the caller may reuse its bytes once the publish promise settles. `createReconnectingClient` throws a RangeError when `resume` is set and `sessionExpiryInterval` is missing, 0 or not an integer up to 4,294,967,295. The broker can lower the interval in CONNACK, and `session.connection.sessionExpiryInterval` holds the value in effect.

| CONNACK | What the client does |
| --- | --- |
| Session Present true | Before any new publication, it sends each stored publication again with DUP set and its Packet Identifier, in the order of the first writes, within the broker's Receive Maximum. The `connected` event lists them in `resent`, with `resumed: true` and empty `subscriptions`. A `puback` event reports the broker's answer to each, after the `connected` event. New publications and subscriptions get other Packet Identifiers. |
| Session Present false | The broker lost the session. The client drops the stored publications without sending them, makes the `subscriptions` again and lists the dropped publications in the event's `dropped`. Their outcome is unknown, and `previous.uncertain` also lists those the previous session had written. |
| Session Present true, and a stored publication is larger than the new Maximum Packet Size | The client sends no PUBLISH. It writes DISCONNECT with reason 0, so the broker keeps the session and discards the Will, and the attempt fails with `ERR_MQTT_SESSION_CONFLICT`. The client keeps the stored publication and retries under the policy below. |
| Session Present true, and the broker's Maximum QoS is now 0 | The same conflict, because the stored QoS 1 publications cannot be sent. |
| Session Present true, a stored publication is retained, and CONNACK sets Retain Available 0 | The same conflict, because the broker no longer accepts the retained publication. |
| Session Present true after Clean Start true | `ERR_MQTT_PROTOCOL` with reason 0x82, as before. A refused CONNACK with Session Present true still fails decoding with `Invalid CONNACK`. |

The original publish promise rejected when its session ended, and the client does not settle it again. A caller reads the outcome of a publication sent again from the `puback` event. If the resumed session ends before that PUBACK, the publication is in `previous.uncertain` of the next `connected` event and stays stored.

`client.resetSession()` makes the next attempt start a new session. That attempt drops the stored publications, lists them in `dropped` of the next `connected` event and sends Clean Start true until a session connects, so the client makes the subscriptions again. A connected session keeps running. Call it, for example, from `onReconnect` after a `retrying` event whose error is `ERR_MQTT_SESSION_CONFLICT`. Without `resume`, it has no effect.

The client writes the resends one at a time. Each resend waits until the write of the one before it settled. New publications wait until every resend was written. When more publications are stored than the broker's Receive Maximum allows at once, that wait includes the PUBACK round trips that free quota for the later resends. A new QoS 1 publication stays queued in that time. It takes no Packet Identifier, is not stored and can still be withdrawn with its signal. A session that ends first rejects it without listing it in `uncertain`. A new QoS 0 publication keeps its admission reservation while it waits, and its write deadline starts only when the wait ends. A session end rejects it with the session's error, and `disconnect()` lets it go out before DISCONNECT. Once the resends are written, the waiting QoS 0 publications go out first, and the queued QoS 1 publications follow in their call order. A TCP or `ws` write settles once the socket took the bytes. Each resend therefore meets a drained socket buffer that no other publication shares. The write budget then refuses only a stored publication larger than `maxBufferedBytes` minus `reservedControlBytes`. Control packets such as PINGREQ and SUBSCRIBE do not wait. A browser WebSocket write settles when the WebSocket accepted the bytes, so its `bufferedAmount` can still hold earlier resends. When the budget refuses a resend, the client writes DISCONNECT with reason 0 and the connection ends with `ERR_MQTT_SESSION_CONFLICT`, whose `cause` is the budget error. The publication stays stored with its Packet Identifier, `previous.uncertain` of the next `connected` event lists it, and no new publication can take its identifier. The reconnecting client retries, and each retry sends the stored publications before the refused one again unless the broker acknowledged them. If the refusal repeats, call `resetSession()` or raise `maxBufferedBytes`.

Inbound QoS 1 messages that the broker sends again after a resume arrive at `onQosOneMessage` with `dup: true`, and the client acknowledges them as any other. Topic Alias maps belong to one connection in MQTT 5, so none carries over. The client sends no Topic Alias and advertises a Topic Alias Maximum of 0, so an aliased PUBLISH after a resume still ends the session with `ERR_MQTT_PROTOCOL` and reason 0x94.

The session state lives in memory. A restarted process starts with an empty one, and a broker session that it resumes then has nothing to send again. A journal that survives a restart is [#14](https://github.com/dvkam/mqtt/issues/14).

A one-shot factory can resume too. Pass the same `createSessionState()` object as `sessionState`, with `cleanStart: false` and a `sessionExpiryInterval`, to each factory of the session. `cleanStart: false` without a `sessionState` rejects with `ERR_MQTT_INVALID_ARGUMENT` before the transport opens, because MQTT-3.2.2-4 makes a client without session state close on Session Present true. A second connection that passes a state another connection holds rejects the same way and opens no transport. Read `sessionState.inFlight` before `connect()` when you need the list, because a CONNACK with Session Present false empties it and a one-shot factory reports no `puback` events.

## Retries

The delay before attempt `n + 1` is drawn from half to all of `min(maxDelayMs, initialDelayMs × 2^(n − 1))`. So `initialDelayMs` is the ceiling of the delay before the second attempt. The defaults are 1,000 and 30,000 milliseconds, and a `maxDelayMs` below `initialDelayMs` is raised to `initialDelayMs`. One timer runs at a time, and the client arms it before it reports the `retrying` event.

`maxAttempts`, 10 by default, counts the attempts since the last stable session. An attempt counts when it fails to connect, and also when its session connects but ends before `stableAfterMs`, which defaults to `maxDelayMs`. A session that stays up for `stableAfterMs` resets the count when it ends. `Infinity` retries forever.

| Outcome | Next step |
| --- | --- |
| `ERR_MQTT_TRANSPORT`, `ERR_MQTT_TIMEOUT` or `ERR_MQTT_SESSION_CONFLICT` | Retry |
| An error that is neither an `MqttError` nor a `RangeError` | Retry |
| A `RangeError` for broker input over a receive limit: a packet over `maxPacketBytes`, the browser receive message limit, or a `ws` message over its limit | Retry |
| CONNACK Server unavailable (0x88), Server busy (0x89), Quota exceeded (0x97) or Connection rate exceeded (0x9F) | Retry |
| Any other CONNACK refusal | Stop with reason `refused` |
| Broker DISCONNECT Malformed Packet (0x81), Protocol Error (0x82), Not authorized (0x87), Session taken over (0x8E), Use another server (0x9C) or Server moved (0x9D) | Stop with reason `fatal` |
| Any other broker DISCONNECT | Retry |
| Any other `MqttError` code, such as `ERR_MQTT_PROTOCOL` or `ERR_MQTT_INVALID_ARGUMENT` | Stop with reason `fatal` |
| Any other `RangeError`, such as one for an invalid factory option like `timeoutMs` | Stop with reason `fatal` |
| Any error thrown by `create` | Stop with reason `fatal` |
| `maxAttempts` attempts since the last stable session | Stop with reason `exhausted` |
| `client.disconnect()` or `disconnect()` on the session | Stop with reason `disconnect` |
| The `signal` in the options aborts | Stop with reason `aborted` |

After a stop, `session()` rejects with the error of the `stopped` event, or with `ERR_MQTT_CLOSING` after a disconnect. That error is the session's error for `refused`, `fatal` and `exhausted`. An abort reason that is an Error is passed through unchanged. Any other abort reason becomes an `ERR_MQTT_ABORTED` error whose `name` is `AbortError` and whose `cause` holds the reason. A value thrown by `create` that is not an Error becomes an `ERR_MQTT_TRANSPORT` error whose `cause` holds the value. `client.disconnect()` clears the timer, abandons an attempt that is opening, and disconnects a connected session with the options you pass. It also works from inside `onReconnect`.

`client.retryNow()` starts the next attempt at once while the client waits for its timer, and clears the timer. It returns true when it started an attempt. That attempt counts toward `maxAttempts` like any other. While an attempt opens, while a session is connected and after a stop, it does nothing and returns false, so it never starts a second attempt or a second timer. In a browser, [`watchPageLifecycle`](page-lifecycle.md) calls it when the page comes back.

In Node, the retry timer keeps the process alive until the client connects or stops.

## Not covered yet

- A session state that survives a process restart, tracked in #14.
- Server Reference redirects, tracked in #16.
