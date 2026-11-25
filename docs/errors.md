# Error codes

Session rejections from `createTcpClient`, `createWebSocketClient`, `createBrowserClient` and `createTransportClient` are `MqttError` instances. Compare `error.code` instead of the message text, which can change. `mqtt`, `mqtt/browser` and `mqtt/portable` export the same class, `isMqttError` and the `MqttErrorCode` type. Tracked in [#155](https://github.com/dvkam/mqtt/issues/155).

```ts
import { isMqttError } from 'mqtt';

try {
  await session.publish('sensor/reading', '24.1');
} catch (error) {
  if (isMqttError(error, 'ERR_MQTT_CAPACITY')) await retryLater();
  else throw error;
}
```

`error.fatal` says whether the session ended. When it is `true`, later calls reject with the same error. Create a new client factory to connect again.

MQTT reason codes are in `error.reasonCode`, not `error.code`. `ProtocolInputError` extends `MqttError`. Before, its numeric `code` held the reason code. Read `reasonCode` instead. `PacketDecoder` from `mqtt/codec` reports the same class. A broker DISCONNECT also carries `reasonString` and `userProperties` when the broker sent them.

| Code | Cause | `fatal` | `reasonCode` |
| --- | --- | --- | --- |
| `ERR_MQTT_INVALID_ARGUMENT` | Invalid topic or filter, unsupported QoS, QoS 1 without a broker or handler that supports it, a `$share/` filter the transport cannot send, or a publish signal without QoS 1 | `false` | None |
| `ERR_MQTT_CAPACITY` | The publication or subscription limit is full, all 65,535 packet identifiers are in use, or another ping awaits PINGRESP | `false` | None |
| `ERR_MQTT_REFUSED` | The broker refused CONNACK | `true` | The CONNACK reason code |
| `ERR_MQTT_REFUSED` | The broker refused SUBACK, UNSUBACK or PUBACK | `false` | The acknowledgment's reason code |
| `ERR_MQTT_TIMEOUT` | An operation passed `timeoutMs`, or a Server Keep Alive deadline passed while an acknowledgment was pending | `true` | None |
| `ERR_MQTT_BROKER_DISCONNECT` | The broker sent DISCONNECT | `true` | The DISCONNECT reason code, 0 when omitted |
| `ERR_MQTT_PROTOCOL` | Malformed or out-of-profile broker input. The error is a `ProtocolInputError`, and an active session sends DISCONNECT with its reason code. | `true` | 0x81, 0x82 or 0x94 |
| `ERR_MQTT_PROTOCOL` | The broker broke a session rule, such as an invalid PUBACK identifier, an invalid CONNACK limit, or more inbound QoS 1 messages than Receive Maximum allows | `true` | 0x93 for Receive Maximum. None otherwise. |
| `ERR_MQTT_CLOSING` | The call came after `disconnect()` | `true` | None |
| `ERR_MQTT_TIMEOUT` | The TCP or TLS connection, or the native WebSocket handshake, did not open within `timeoutMs` | `true` | None |
| `ERR_MQTT_TRANSPORT` | The socket or WebSocket closed, a WebSocket handshake or subprotocol check failed, a text WebSocket message arrived, or no native WebSocket exists | `true` | None |
| `ERR_MQTT_ABORTED` | The signal aborted with a reason that is not an Error. The error's `name` is `AbortError`. | `true` | None |

## Not yet coded

These still reject with their existing errors. Code them before treating the list above as complete.

- Codec failures that MQTT 5 gives no reason code, such as many property defects and packets over `maxPacketBytes`, are plain `Error` or `RangeError` values.
- Option validation before connecting, such as `timeoutMs` or publication limits, throws `RangeError`.
- Native socket and `ws` errors pass through unchanged, as do custom transport errors.
- A write budget refusal is a plain `Error`. Whether it ends the session depends on the packet, so it needs a separate decision.
- The browser receive message limit is a `RangeError`.
- An abort whose reason is an Error rejects with that Error unchanged.
