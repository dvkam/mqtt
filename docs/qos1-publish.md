# Outbound QoS 1 publishing

## Disconnect with active publications

`disconnect()` rejects queued publications and stops admitting new work. It waits for active QoS 1 writes and their PUBACKs before it sends DISCONNECT. A successful PUBACK settles the publication normally. A refused PUBACK keeps its broker reason.

Set `disconnect({ drainTimeoutMs: 1000 })` to give the drain its own deadline. The default is the connection's operation timeout. After expiry, the client preserves any matching PUBACK it already received. Publications whose PUBACK is still missing reject with `MQTT QoS 1 drain expired. Delivery outcome is unknown`. The session then tries to send DISCONNECT under its ordinary write deadline. Check your application's delivery record before retrying those publications.

Keep Alive continues during the drain. Use `disconnect({ drain: false })` to start the DISCONNECT write without waiting. This can leave earlier publications unacknowledged. A transport failure during either form of shutdown keeps its original error. Only the first valid `disconnect()` call chooses the options. `reasonCode: 4` asks the broker to publish its configured Will. The default reason is normal disconnection. [#147](https://github.com/dvkam/mqtt/issues/147)

Pass `{ qos: 1 }` as the third argument to `publish` to wait for the broker's PUBACK. The two-argument form uses QoS 0. The same interface works through the TCP, Node WebSocket, browser and portable packet clients.

```ts
const controller = new AbortController();
const sent = client.publish('sensors/temperature', '21.5', { qos: 1, signal: controller.signal });
await sent;
```

`PublishOptions` is available from `mqtt`, `mqtt/browser` and `mqtt/portable`. A signal that is already aborted rejects any publish with its reason. At QoS 1, a later abort withdraws a queued publication with the caller's abort reason. The queue observes a private dependent signal so another listener cannot suppress cancellation by stopping event propagation. [DOM Standard](https://dom.spec.whatwg.org/#interface-AbortSignal)

## Admission and quota

The session snapshots Receive Maximum and Maximum QoS from the first matching successful CONNACK. Receive Maximum defaults to 65,535 when absent. Maximum QoS `0` disables QoS 1 for that connection. An invalid supplied limit rejects the connection attempt. [MQTT 5 sections 3.2.2.3 and 4.9](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

Queued and dispatched QoS 1 publications share `maxPendingPublishes` and `maxPendingPublishBytes` with QoS 0 sends. Their byte charge includes the packet identifier and complete Remaining Length encoding. An excess request rejects before acquiring an identifier, creating a timer or sending. Admitted QoS 1 requests dispatch in order as broker quota becomes available. QoS 0, subscriptions and ping can proceed while QoS 1 waits for acknowledgments.

The dispatcher leases an ID only when the request leaves the queue. PUBLISH, SUBSCRIBE and UNSUBSCRIBE use the same outbound namespace. Exhaustion rejects that request locally and returns its capacity. A subsequent request can use a released ID. The operation timeout starts at dispatch and lasts through send completion and PUBACK. Queued requests have bounded item and byte ownership and can be canceled while they wait.

## Completion and cancellation

Each dispatched exchange occupies its quota slot and packet ID until the actual send and its matching PUBACK settle. A PUBACK that arrives before the write callback does not free that slot. Code `0` or `16` completes the request. A valid negative reason rejects with an `ERR_MQTT_REFUSED` error that carries the numeric `reasonCode`, and permits later dispatch after send settlement. A valid unmatched ID or another acknowledgment kind leaves that exchange pending. The shared session retires on malformed PUBACK identifiers or reason codes. [MQTT 5 sections 2.2.1 and 3.4](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

Cancellation removes a queued request and returns its budget. After dispatch it settles the caller's promise while the exchange continues to own its ID, quota and bytes. A later matching PUBACK and send completion release that ownership. This distinction matters because a broker may receive a publication after the caller stops waiting.

If a built-in transport refuses a QoS 1 publication at its native write budget before submitting it, the call rejects with the budget error, returns its quota, ID and publication capacity, and leaves the session usable. Other send errors retire the session because the amount that reached the peer is unknown. A connection failure or timeout rejects pending callers. The actual send can continue to hold its byte reservation until it settles. Disconnect stops queued dispatch before starting its DISCONNECT write and retires unfinished exchanges on closure.

The QoS 1 promise covers the broker acknowledgment for the current connection. [Inbound QoS 1](qos1-receive.md) has a separate receive window. After a session ends, a [reconnecting client](reconnect.md) lists the QoS 1 publications that were in flight in its next `connected` event, even after failed attempts. A publication counts as acknowledged there only when its PUBACK reason was below 0x80. Without a session state, the client does not send them again.

## Resumed sessions

With a `sessionState`, the client copies each QoS 1 publication into the state before its first write and deletes it when its PUBACK arrives, whatever the reason code. When a later connection sends Clean Start false and the broker answers with Session Present true, the client sends every stored publication again with DUP set and its Packet Identifier, in the order of the first writes and before any queued publication. It never sends a stored publication with a new Packet Identifier. The resends count toward the broker's Receive Maximum, and their identifiers are reserved before the session accepts work, so a new PUBLISH, SUBSCRIBE or UNSUBSCRIBE uses another one. The publish promise of a resent publication rejected with the error of its own session, so the PUBACK of the resend does not settle it. A [reconnecting client](reconnect.md#resuming-the-session) reports that PUBACK in a `puback` event. Resends go out one at a time, each after the write of the one before it settled, and new QoS 1 publications wait until every resend was written. A new publication that the write budget refused before writing it leaves the state at once. A resend that the budget refuses ends the connection with `ERR_MQTT_SESSION_CONFLICT` instead, so the publication stays stored with its Packet Identifier and no new publication can take that identifier. [Resuming the session](reconnect.md#resuming-the-session) describes when that happens and how to recover.

The copy allocates the payload bytes and the publication object, and with Correlation Data also the property object and those bytes. It happens only when `sessionState` is set. Without it, the publish path keeps the caller's bytes as before.

## Verification

Scripted peers exercise quota one and two, shared-ID exhaustion, held native writes, matching ACKs, malformed ACKs, both cancellation phases and close fencing. The installed tarball fixtures publish QoS 1 through the public clients against Mosquitto over TCP, WS and WSS before their existing QoS 0 echo checks.

The bounded model uses three publication requests, three abstract IDs and a held subscription ID. It checks quota one and two with a two-item, three-unit admission budget. It separates enqueue, dispatch, send settlement, acknowledgment, cancellation, stop and retirement. Concrete tests cover UTF-8 arithmetic, native signals, actual packet types, full-range IDs and scheduling. Formal assumptions and source fault replays are in the repository verification guide.
