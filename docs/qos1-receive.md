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

Node handlers receive a `Buffer`. Browser handlers receive a `Uint8Array`. The QoS 1 callback also receives a numeric `messageId` and boolean `dup`. `QosOneMessage` and `SubscribeOptions` are exported types. The QoS 0 callback keeps its existing payload and QoS types.

## Flow control

The opt-in advertises Receive Maximum 1 in CONNECT. The client sends PUBACK after the handler returns or fulfills. The operation deadline covers the handler and PUBACK write. Control packets and QoS 0 callbacks can proceed while the handler waits. Incoming IDs are scoped to the broker-to-client direction, so an outgoing exchange may hold the same number. The broker can reuse an ID after PUBACK. The new delivery still reaches the handler when its DUP flag is set. [MQTT 5 sections 2.2.1, 3.1.2.11, 4.3.2, 4.6 and 4.9](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

A QoS 1 publication can arrive with successful CONNACK while the local CONNECT write is settling. The session retains one such publication and delivers it at activation. The handler can run before the connection promise resolves. After activation, a publication received before PUBACK submission exceeds the one-slot window if another handler is running. Once PUBACK is submitted, the peer can receive it before the native send callback completes. The client retains at most one next publication during that interval and dispatches it after the write settles. This gives one active delivery and one locally retained follower. Native framing and packet size limits apply separately.

## Failure and close

A handler rejection, inbound deadline, or failed PUBACK write retires the connection and preserves its first failure. An excess publication triggers a bounded attempt to send DISCONNECT with reason 0x93 before forcing transport closure. The public error keeps code 0x93 if that report cannot be written. Graceful disconnect stops new deliveries, discards the follower and prevents late PUBACK submission. An already-running handler can finish its own application work. The client cannot cancel that work.

QoS 1 covers acknowledgment on the current clean connection. The application owns durable or idempotent processing and should handle repeat delivery. These clients do not implement persistent session replay or QoS 2 delivery.

## Verification

Fixed wire vectors cover CONNECT Receive Maximum, QoS 1 SUBSCRIBE and DISCONNECT 0x93. Scripted peers cover separate ID directions, opening delivery, held handlers and writes, overflow, failures and the graceful-close fence. Packed Mosquitto fixtures verify that ping still succeeds with the first handler held, then confirm the second QoS 1 delivery after release. The DOM-only type fixture checks that the browser callback and subscription types compile without Node declarations.
