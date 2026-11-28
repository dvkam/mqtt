# Error codes

Session rejections from `createTcpClient`, `createWebSocketClient`, `createBrowserClient` and `createTransportClient` are `MqttError` instances. Compare `error.code` instead of the message text, which can change. `mqtt`, `mqtt/browser` and `mqtt/portable` export the same class, `isMqttError` and the `MqttErrorCode` type. [#155](https://github.com/dvkam/mqtt/issues/155) tracks the errors that have no code yet.

```ts
import { isMqttError } from 'mqtt';

try {
  await session.publish('sensor/reading', '24.1');
} catch (error) {
  if (isMqttError(error, 'ERR_MQTT_CAPACITY')) await retryLater();
  else throw error;
}
```

`error.fatal` says whether the session ended. When it is `true`, later calls reject with the same error, except that each call after `disconnect()` gets a new `ERR_MQTT_CLOSING` error. Create a new client factory to connect again. If an `onMessage` or `onQosOneMessage` handler rethrows a non-fatal rejection, the session ends with a fatal copy. The copy keeps the code and sets `cause` to the original. An abort passes the signal's reason through unchanged, so an `MqttError` reason keeps the `fatal` value its creator gave it.

After a [reconnecting client](reconnect.md) stops, its `session()` rejects with `ERR_MQTT_CLOSING` after a disconnect. Otherwise it rejects with the error of the `stopped` event. That error is the session error that stopped the client, the abort reason, or one of the `ERR_MQTT_ABORTED` and `ERR_MQTT_TRANSPORT` errors in the table.

A later release can add a code. Check for the codes you handle, as `isMqttError(error, 'ERR_MQTT_CAPACITY')` does, and treat any other code as unhandled. A `switch` on `error.code` needs a `default` branch.

MQTT reason codes are in `error.reasonCode`, not `error.code`. `ProtocolInputError` extends `MqttError`. Before, its numeric `code` held the reason code. Read `reasonCode` instead. `PacketDecoder` from `mqtt/codec` reports `ProtocolInputError` too. `mqtt/codec` does not export the class, so import it from `mqtt/portable` to narrow the error. A broker DISCONNECT and a refused CONNACK also carry `reasonString` and `userProperties` when the broker sent them.

| Code | Cause | `fatal` | `reasonCode` |
| --- | --- | --- | --- |
| `ERR_MQTT_INVALID_ARGUMENT` | Invalid topic or filter, unsupported QoS, QoS 1 without a broker or handler that supports it, a `$share/` filter the transport cannot send, an invalid publish payload, PUBLISH property or publish signal, `retain` when the broker does not allow it, an invalid Will, a password over 65,535 bytes or of another type, a `cleanStart` that is not a boolean, a `sessionExpiryInterval` that is not an integer from 0 to 4,294,967,295, a `sessionState` that `createSessionState()` did not make or that another connection uses, `cleanStart: false` without a `sessionState`, or an invalid `disconnect()` option | `false` | None |
| `ERR_MQTT_CAPACITY` | The publication or subscription limit is full, a PUBLISH, SUBSCRIBE or UNSUBSCRIBE is larger than the broker's Maximum Packet Size from CONNACK, all 65,535 packet identifiers are in use, or another ping awaits PINGRESP | `false` | None |
| `ERR_MQTT_REFUSED` | The broker refused CONNACK | `true` | The CONNACK reason code |
| `ERR_MQTT_REFUSED` | The broker refused SUBACK, UNSUBACK or PUBACK | `false` | The acknowledgment's reason code |
| `ERR_MQTT_TIMEOUT` | An operation passed `timeoutMs`, or a Server Keep Alive deadline passed while an acknowledgment was pending | `true` | None |
| `ERR_MQTT_TIMEOUT` | The TCP or TLS connection, or the native WebSocket handshake, did not open within `timeoutMs` | `true` | None |
| `ERR_MQTT_TIMEOUT` | The disconnect drain passed `drainTimeoutMs` without a PUBACK. The publication outcome is unknown and DISCONNECT proceeds. | `true` | None |
| `ERR_MQTT_BROKER_DISCONNECT` | The broker sent DISCONNECT | `true` | The DISCONNECT reason code, 0 when omitted |
| `ERR_MQTT_PROTOCOL` | Malformed or out-of-profile broker input, such as a PUBACK with packet identifier 0. The error is a `ProtocolInputError`, and an active session sends DISCONNECT with its reason code. | `true` | 0x81, 0x82 or 0x94 |
| `ERR_MQTT_PROTOCOL` | A QoS 1 PUBLISH arrived before CONNACK on a client with an `onQosOneMessage` handler. The error is an `MqttError`, not a `ProtocolInputError`. The client sends no DISCONNECT and closes the transport. | `true` | None |
| `ERR_MQTT_PROTOCOL` | The broker's CONNACK set Maximum Packet Size from 1 to 3, which leaves no room for the client's 4-byte PUBACK. The error is an `MqttError`, not a `ProtocolInputError`. The client sends no DISCONNECT and closes the transport. | `true` | None |
| `ERR_MQTT_PROTOCOL` | The broker sent more inbound QoS 1 messages than the client's Receive Maximum allows. The error is an `MqttError`, not a `ProtocolInputError`. The client sends DISCONNECT with reason 0x93 and closes the transport. | `true` | 0x93 |
| `ERR_MQTT_CLOSING` | The call came after `disconnect()` | `true` | None |
| `ERR_MQTT_TRANSPORT` | The socket or WebSocket closed, a WebSocket handshake or subprotocol check failed, a text WebSocket message arrived, or no native WebSocket exists. Also used when a custom transport's `open`, or a write of CONNECT, PINGREQ, DISCONNECT, SUBSCRIBE, UNSUBSCRIBE or a QoS 1 PUBLISH, rejects with a value that is not an Error. A reconnecting client uses it when its `create` function throws a value that is not an Error. `cause` then holds that value. | `true` | None |
| `ERR_MQTT_SESSION_CONFLICT` | The broker resumed the session, and a stored QoS 1 publication is larger than its new Maximum Packet Size, is retained while CONNACK sets Retain Available 0, or the broker's Maximum QoS is now 0. The client sends no PUBLISH, writes DISCONNECT with reason 0 and keeps the stored publications. A [reconnecting client](reconnect.md#resuming-the-session) retries. | `true` | 0, the DISCONNECT the client sent |
| `ERR_MQTT_SESSION_CONFLICT` | The native write budget refused a stored publication that a resumed session sent again. `cause` holds the budget error. The client writes DISCONNECT with reason 0 and keeps the stored publications, and a reconnecting client retries. | `true` | 0, the DISCONNECT the client sent |
| `ERR_MQTT_ABORTED` | The connection signal, or the signal of a reconnecting client, aborted with a reason that is not an Error. The error's `name` is `AbortError`, and `cause` holds the reason. A publish signal passes its reason through unchanged at either QoS. | `true` | None |

## Gaps

These rejections have no code yet, or lack a field that #155 asks for.

- A non-Error value thrown by an `onMessage` or `onQosOneMessage` handler ends the session with a plain `Error`.
- A refused SUBACK, UNSUBACK or PUBACK has a `reasonCode` but no `reasonString` or `userProperties` yet.
- Errors from `ws` and the native socket, such as `Server sent no subprotocol`, pass through unchanged.
- Codec failures that are not a `ProtocolInputError` are plain `Error` or `RangeError` values. Examples are invalid fixed-header flags, a malformed Remaining Length, a truncated field, many property defects such as a CONNACK Receive Maximum of 0 or Maximum QoS of 2, and a packet over `maxPacketBytes`. MQTT 5 treats most of them as Malformed Packet 0x81.
- An inbound QoS 2 PUBLISH, when an `onQosOneMessage` handler is set, ends the session with a plain `Error`.
- A QoS 0 publish write and the transport `close` during `disconnect()` reject with the transport's own value, even when it is not an Error.
- Invalid client options such as `timeoutMs` or publication limits throw `RangeError`, and so does an invalid `checkAfterMs` of `watchPageLifecycle`. The Will, the password, the session options and the `disconnect()` options are the exception: they reject with `ERR_MQTT_INVALID_ARGUMENT`. For the Will and `disconnect()`, the original error is the cause.
- Custom transport errors pass through unchanged.
- A write budget refusal is a plain `Error`. It leaves the session usable when it refuses a new publication and ends the session when it refuses a control packet. When it refuses a resend after a resume, the session ends with `ERR_MQTT_SESSION_CONFLICT`, and the budget error is its `cause`.
- The browser receive message limit is a `RangeError`.
- After a reconnecting client stops, `session()` rejects with the stopping error unchanged. That error can be a `RangeError` for an invalid factory option, an Error abort reason or another error that is not an `MqttError`.
