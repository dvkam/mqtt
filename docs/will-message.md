# Will messages

Set `will` when the broker should publish a status message after the client loses its connection. The TCP, Node WebSocket, browser, and custom transport factories use the same `WillOptions` type.

```ts
import { createTcpClient } from 'mqtt';

const factory = createTcpClient({
  host: '127.0.0.1',
  clientId: 'sensor-7',
  will: { topic: 'sensors/7/status', payload: 'offline', qos: 1, retain: true },
});

const session = await factory.connect();
await session.disconnect({ reasonCode: 4 });
```

The last call requests the Will even for a deliberate shutdown. Use `disconnect()` for a normal shutdown that discards the Will. The call waits for local disconnect and close settlement. To verify Will delivery, observe the Will topic with a separate client. [Disconnect options](qos1-publish.md#disconnect-with-active-publications)

The Will requires a topic name and a payload. Use a string for UTF-8 text or a Uint8Array for bytes. The topic follows the publish rules. The client checks it before opening the connection and copies the payload, Correlation Data, and User Property pairs at that point. The payload and Correlation Data each hold up to 65,535 bytes. The broker can publish the Will at QoS 0, 1, or 2. Will QoS defaults to 0 and `retain` defaults to false.

`delayInterval` and `messageExpiryInterval` are whole seconds. The broker publishes a Will when the Will Delay expires or the MQTT session ends, whichever happens first. The preview opens clean sessions with zero Session Expiry, so a positive Will Delay can still produce an immediate notification. A broker can refuse CONNECT if it cannot honor Will QoS or Retain. The `ERR_MQTT_REFUSED` error carries the broker's `reasonCode`. [Error codes](errors.md)

With `payloadFormatIndicator: 1`, the payload must be well-formed UTF-8. `contentType`, `responseTopic`, `correlationData`, and ordered `userProperties` go into the Will property section. `mqtt/codec` accepts and returns a byte payload in its CONNECT `WillMessage`. [Codec profile](codec.md#supported-profile) · [MQTT 5 specification](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

The packed broker check uses a separate subscriber and tests an interrupted connection, normal DISCONNECT, and DISCONNECT reason 4 on TCP, Node WebSocket, and Chromium. [Will test scenario](../test/packed/will-scenario.mjs)
