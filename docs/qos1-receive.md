# Inbound QoS 1 delivery

Set `onQosOneMessage` when creating a supported TCP, Node WebSocket, browser or portable packet client. Request QoS 1 with `subscribe(topic, { qos: 1 })`. The broker can grant QoS 0. Set `onMessage` too if the application handles those deliveries. Both handlers receive their respective QoS even if they share a topic.

```ts
const client = await createTcpClient({
  host: 'localhost',
  clientId: 'reader',
  async onQosOneMessage(message) {
    await saveReading(message.topic, message.payload);
  },
}).connect();

await client.subscribe('sensors/+/temperature', { qos: 1 });
```

Node handlers receive a `Buffer`. Browser handlers receive a `Uint8Array`. The QoS 1 callback also receives a numeric `messageId` and boolean `dup`. `QosOneMessage` and `SubscribeOptions` are exported types. The QoS 0 callback keeps its existing payload and QoS types. Both callbacks receive the [flat message fields](public-types.md#received-message-fields).

## Flow control

The opt-in advertises Receive Maximum 1 in CONNECT. The client sends PUBACK after the handler returns or fulfills. The operation deadline covers the handler and PUBACK write. Control packets and QoS 0 callbacks can proceed while the handler waits. Incoming IDs are scoped to the broker-to-client direction, so an outgoing exchange may hold the same number. The broker can reuse an ID after PUBACK. The new delivery still reaches the handler when its DUP flag is set. [MQTT 5 sections 2.2.1, 3.1.2.11, 4.3.2, 4.6 and 4.9](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

A QoS 1 publication can arrive with successful CONNACK while the local CONNECT write is settling. The session retains one such publication and delivers it at activation. The handler can run before the connection promise resolves. After activation, a publication received before PUBACK submission exceeds the one-slot window if another handler is running. Once PUBACK is submitted, the peer can receive it before the native send callback completes. The client retains at most one next publication during that interval and dispatches it after the write settles. This gives one active delivery and one locally retained follower. Native framing and packet size limits apply separately.

## Failure and close

A handler rejection, inbound deadline, or failed PUBACK write retires the connection and preserves its first failure. An excess publication triggers a bounded attempt to send DISCONNECT with reason 0x93 before forcing transport closure. The public error keeps code 0x93 if that report cannot be written. Graceful disconnect stops new deliveries, discards the follower and prevents late PUBACK submission. An already-running handler can finish its own application work. The client cannot cancel that work.

QoS 1 delivers at least once. The client keeps no record of inbound QoS 1 messages between connections. When a session resumes with `cleanStart: false`, the broker sends again, with DUP set, each message the client has not acknowledged, and the handler receives it again. The application owns durable or idempotent processing and should handle repeat delivery. [Resuming the session](reconnect.md#resuming-the-session) [QoS 2](qos2.md#receive-at-qos-2) describes delivery that happens once.

## A PUBLISH the client cannot acknowledge

MQTT-4.5.0-2 reads "The Client MUST acknowledge any Publish packet it receives according to the applicable QoS rules regardless of whether it elects to process the Application Message that it contains". MQTT-3.3.4-1 and MQTT-4.3.2-4 make PUBACK the answer to a QoS 1 PUBLISH, and the receiver sends it "having accepted ownership of the Application Message". The client sends an acknowledgment only after a handler took the message, so it never accepts ownership of a message that no code received. The handlers therefore set the highest QoS the client acknowledges.

| Handlers | Highest QoS the client subscribes at and acknowledges |
| --- | --- |
| None, or only `onMessage` | 0 |
| `onQosOneMessage` | 1 |
| `onQosOneMessage` and `onQosTwoMessage` | 2 |
| `onQosTwoMessage` without `onQosOneMessage` | None. `connect()` rejects with `ERR_MQTT_INVALID_ARGUMENT` before the transport opens, because a QoS 2 subscription also delivers QoS 1 publications. |

A QoS 1 or QoS 2 PUBLISH above that QoS ends the session with `ERR_MQTT_PROTOCOL`. The error is a `ProtocolInputError`, and the client sends DISCONNECT with reason 0x82 and closes the transport. A client without the handler used to drop such a PUBLISH and send nothing. The broker's send quota then filled, and delivery stalled without an error. The TCP, Node WebSocket, browser and custom transport clients share the rule, which is in the session and not in a transport.

`subscribe` rejects a QoS above the handlers, and the broker delivers at the lower of the publication's QoS and the granted QoS (MQTT-3.8.4-8). Such a PUBLISH therefore comes from a broker that broke that rule, or from a subscription that this client did not make. [Resumed sessions](#resumed-sessions) describes the second case. Among the DISCONNECT reason codes of MQTT 5 section 3.14.2.1, a client may send 0x82, Protocol Error, for an unexpected packet. 0x9B, QoS not supported, is for the server only.

### Before CONNACK

MQTT-3.2.0-1 reads "The Server MUST send a CONNACK with a 0x00 (Success) Reason Code before sending any Packet other than AUTH". A PUBLISH of any QoS, a PUBACK, PUBREC, PUBREL, PUBCOMP, SUBACK, UNSUBACK or PINGRESP that arrives before CONNACK ends the attempt, whatever handlers the client has. `connect()` rejects with `ERR_MQTT_PROTOCOL` and reason 0x82, and the error is a `ProtocolInputError`. The client sends no DISCONNECT and closes the transport, as for every protocol error before CONNACK. MQTT 5 section 4.13.1 recommends a DISCONNECT with the reason code and does not require one. A DISCONNECT before CONNACK ends the attempt with `ERR_MQTT_BROKER_DISCONNECT` and the broker's reason code. AUTH is a protocol error in every phase.

### Resumed sessions

A broker session that resumes still has its subscriptions, so the broker delivers at their granted QoS as soon as it sent CONNACK. The [session state](reconnect.md#resuming-the-session) records the highest QoS that a SUBACK of the session granted. A connection with `cleanStart: false` whose handlers are below that QoS rejects with `ERR_MQTT_INVALID_ARGUMENT` before the transport opens. A CONNACK with Session Present false resets the record. A connection with Clean Start true skips the check, because the broker then discards the subscriptions. An unsubscribe does not lower the record.

The state knows a subscription only from its SUBACK. It does not know a subscription that another process made under the same Client Identifier, one from an earlier process whose state is gone, one whose SUBACK never arrived, or one that the broker assigned. A PUBLISH above the handlers from such a subscription ends the session with the protocol error above, although the broker delivered it correctly. Give the client the handlers for the highest QoS of any subscription the broker session can hold.

## Verification


Fixed wire vectors cover CONNECT Receive Maximum, QoS 1 SUBSCRIBE and DISCONNECT 0x93. Scripted peers cover separate ID directions, opening delivery, held handlers and writes, overflow, failures and the graceful-close fence. Packed Mosquitto fixtures verify that ping still succeeds with the first handler held, then confirm the second QoS 1 delivery after release. The DOM-only type fixture checks that the browser callback and subscription types compile without Node declarations. `test/inbound-acknowledgement.test.ts` covers a PUBLISH above the handlers for each handler set, over a scripted transport and over the TCP, Node WebSocket and browser clients. It also covers each packet before CONNACK and the granted QoS in the session state.
