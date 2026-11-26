# Publishing

`session.publish(topic, payload, options)` sends one PUBLISH. The payload is a string, which the client sends as UTF-8, or a `Uint8Array`, which it sends unchanged.

```ts
await session.publish('sensor/7/reading', '24.1');
await session.publish('sensor/7/frame', Uint8Array.of(0x01, 0x02, 0x03), { qos: 1 });
```

The client keeps a reference to a `Uint8Array` payload and to Correlation Data, and copies them into the frame when it writes the PUBLISH. Do not change those bytes before the returned promise settles.

## Options

`PublishOptions` holds the QoS, a cancellation signal, the retain flag and the MQTT 5 PUBLISH properties. An omitted property is not sent.

| Option | Type | Sent as |
| --- | --- | --- |
| `qos` | `0` or `1` | The PUBLISH QoS. Defaults to 0. |
| `signal` | `AbortSignal` | Not sent. See [cancellation](#cancellation). |
| `retain` | `boolean` | The RETAIN flag. The broker keeps the message for later subscribers. |
| `payloadFormatIndicator` | `0` or `1` | 1 marks the payload as UTF-8 text. |
| `messageExpiryInterval` | Integer from 0 to 4,294,967,295 | Seconds the broker keeps an undelivered message. |
| `contentType` | MQTT UTF-8 string | A description of the payload, such as a MIME type. |
| `responseTopic` | Topic name without wildcards | The topic a responder publishes its reply to. |
| `correlationData` | `Uint8Array` of at most 65,535 bytes | Bytes that tie a reply to its request. |
| `userProperties` | Array of `[key, value]` string pairs | Sent in array order. A key can repeat. |

A received message has the same property fields, so a client can forward it to another broker:

```ts
const archive = await createTcpClient({ host: 'archive.example', clientId: 'archive' }).connect();
const source = await createTcpClient({
  host: 'broker.example',
  clientId: 'forwarder',
  onMessage(message) {
    archive.publish('archive/' + message.topic, message.payload, message).catch(report);
  },
}).connect();
```

The client reads only the options above from the message, including its `retain` flag, and ignores the other fields.

## Request and response

Set `responseTopic` and `correlationData` on the request. The responder publishes its reply to that topic with the same Correlation Data.

```ts
const requestId = crypto.getRandomValues(new Uint8Array(8));
await session.subscribe('reply/sensor-7');
await session.publish('commands/calibrate', JSON.stringify({ offset: 0.2 }), {
  qos: 1,
  responseTopic: 'reply/sensor-7',
  correlationData: requestId,
  contentType: 'application/json',
});
```

## Validation

Each check runs before the publication is admitted or written. A failed check rejects with `ERR_MQTT_INVALID_ARGUMENT`, and the session stays usable.

- A string payload with an unpaired surrogate is rejected. The UTF-8 encoder would otherwise replace it with U+FFFD.
- With `payloadFormatIndicator: 1`, a byte payload must be valid UTF-8.
- `retain: true` is rejected when the broker's CONNACK set Retain Available to 0.
- The Content Type, Response Topic and User Property strings follow the MQTT UTF-8 string rules: at most 65,535 bytes, no U+0000 and no unpaired surrogate. A text payload has no length or U+0000 limit, but it must not contain an unpaired surrogate.

The publication byte limit, `maxPendingPublishBytes`, counts the whole PUBLISH, including the property section. A publication that does not fit rejects with `ERR_MQTT_CAPACITY`. [Outgoing admission](outgoing-admission.md)

## Cancellation

The signal must be an AbortSignal, from any realm. A signal that is already aborted rejects the call with the signal's reason, and nothing is sent. At QoS 1, a later abort withdraws a publication that is still queued. At QoS 0, the client writes the PUBLISH at once, so a later abort has no effect. [QoS 1 publishing](qos1-publish.md)
