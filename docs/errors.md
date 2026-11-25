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

MQTT reason codes are in `error.reasonCode`, not `error.code`. A broker DISCONNECT also carries `reasonString` and `userProperties` when the broker sent them.

| Code | Cause | `fatal` | `reasonCode` |
| --- | --- | --- | --- |
| `ERR_MQTT_INVALID_ARGUMENT` | Invalid topic or filter, unsupported QoS, QoS 1 without a broker or handler that supports it, a `$share/` filter the transport cannot send, or a publish signal without QoS 1 | `false` | None |
| `ERR_MQTT_CAPACITY` | The publication or subscription limit is full, all 65,535 packet identifiers are in use, or another ping awaits PINGRESP | `false` | None |
| `ERR_MQTT_REFUSED` | The broker refused CONNACK | `true` | The CONNACK reason code |
| `ERR_MQTT_REFUSED` | The broker refused SUBACK, UNSUBACK or PUBACK | `false` | The acknowledgment's reason code |
| `ERR_MQTT_TIMEOUT` | An operation passed `timeoutMs`, or a Server Keep Alive deadline passed while an acknowledgment was pending | `true` | None |
| `ERR_MQTT_BROKER_DISCONNECT` | The broker sent DISCONNECT | `true` | The DISCONNECT reason code, 0 when omitted |
| `ERR_MQTT_PROTOCOL` | The broker broke a session rule, such as an invalid PUBACK identifier, an invalid CONNACK limit, or more inbound QoS 1 messages than Receive Maximum allows | `true` | 0x93 for Receive Maximum. None otherwise. |
| `ERR_MQTT_CLOSING` | The call came after `disconnect()` | `true` | None |

## Not yet coded

These still reject with their existing errors. Code them before treating the list above as complete.

- Decoder and session input errors remain `ProtocolInputError`. Its numeric `code` is the MQTT reason code, 0x81, 0x82 or 0x94.
- Option validation before connecting, such as `timeoutMs` or publication limits, throws `RangeError`.
- Transport failures, write budget refusals and native socket errors keep their transport's error.
- An abort rejects with the signal's own reason, or an `AbortError` when the reason is not an Error. This stays as it is.
