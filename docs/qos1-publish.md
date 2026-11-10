# Outbound QoS 1 publishing

Pass `{ qos: 1 }` as the third argument to `publish` to wait for the broker's PUBACK. The two-argument form uses QoS 0. The same interface works through the TCP, Node WebSocket, browser and portable packet clients.

```ts
const controller = new AbortController();
const sent = client.publish('sensors/temperature', '21.5', { qos: 1, signal: controller.signal });
await sent;
```

`PublishOptions` is available from `mqtt` and `mqtt/browser`. A publication signal applies to a QoS 1 call. It rejects with the caller's abort reason. The queue observes a private dependent signal so another listener cannot suppress cancellation by stopping event propagation. [DOM Standard](https://dom.spec.whatwg.org/#interface-AbortSignal)

## Admission and quota

The session snapshots Receive Maximum and Maximum QoS from the first matching successful CONNACK. Receive Maximum defaults to 65,535 when absent. Maximum QoS `0` disables QoS 1 for that connection. An invalid supplied limit rejects the connection attempt. [MQTT 5 sections 3.2.2.3 and 4.9](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

Queued and dispatched QoS 1 publications share `maxPendingPublishes` and `maxPendingPublishBytes` with QoS 0 sends. Their byte charge includes the packet identifier and complete Remaining Length encoding. An excess request rejects before acquiring an identifier, creating a timer or sending. Admitted QoS 1 requests dispatch in order as broker quota becomes available. QoS 0, subscriptions and ping can proceed while QoS 1 waits for acknowledgments.

The dispatcher leases an ID only when the request leaves the queue. PUBLISH, SUBSCRIBE and UNSUBSCRIBE use the same outbound namespace. Exhaustion rejects that request locally and returns its capacity. A subsequent request can use a released ID. The operation timeout starts at dispatch and lasts through send completion and PUBACK. Queued requests have bounded item and byte ownership and can be canceled while they wait.

## Completion and cancellation

Each dispatched exchange occupies its quota slot and packet ID until the actual send and its matching PUBACK settle. A PUBACK that arrives before the write callback does not free that slot. Code `0` or `16` completes the request. A valid negative reason rejects with its numeric `code` and permits later dispatch after send settlement. A valid unmatched ID or another acknowledgment kind leaves that exchange pending. The shared session retires on malformed PUBACK identifiers or reason codes. [MQTT 5 sections 2.2.1 and 3.4](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

Cancellation removes a queued request and returns its budget. After dispatch it settles the caller's promise while the exchange continues to own its ID, quota and bytes. A later matching PUBACK and send completion release that ownership. This distinction matters because a broker may receive a publication after the caller stops waiting.

If a built-in transport refuses a QoS 1 publication at its native write budget before submitting it, the call rejects with the budget error, returns its quota, ID and publication capacity, and leaves the session usable. Other send errors retire the session because the amount that reached the peer is unknown. A connection failure or timeout rejects pending callers. The actual send can continue to hold its byte reservation until it settles. Disconnect stops queued dispatch before starting its DISCONNECT write and retires unfinished exchanges on closure.

The current profile opens clean sessions. The QoS 1 promise covers the broker acknowledgment for the current connection. [Inbound QoS 1](qos1-receive.md) has a separate receive window. Reconnect ownership is tracked in #12.

## Verification

Scripted peers exercise quota one and two, shared-ID exhaustion, held native writes, matching ACKs, malformed ACKs, both cancellation phases and close fencing. The installed tarball fixtures publish QoS 1 through the public clients against Mosquitto over TCP, WS and WSS before their existing QoS 0 echo checks.

The bounded model uses three publication requests, three abstract IDs and a held subscription ID. It checks quota one and two with a two-item, three-unit admission budget. It separates enqueue, dispatch, send settlement, acknowledgment, cancellation, stop and retirement. Concrete tests cover UTF-8 arithmetic, native signals, actual packet types, full-range IDs and scheduling. Formal assumptions and source fault replays are in the repository verification guide.
