# Bounded concurrent subscriptions

The supported TCP, Node WebSocket, browser and custom packet clients can run several subscriptions concurrently. Each request reserves a packet identifier and waits for its own SUBACK. Reversed acknowledgment order does not complete the wrong request. Ping retains a separate, unnumbered response slot.

```ts
import { createTcpClient } from 'mqtt';

const client = await createTcpClient({
  host: 'localhost',
  clientId: 'dashboard',
  maxPendingSubscriptions: 8,
  maxPendingSubscriptionBytes: 65536,
}).connect();

try {
  await Promise.all([
    client.subscribe('sensors/+/temperature'),
    client.subscribe('sensors/+/humidity'),
    client.ping(),
  ]);
} finally {
  await client.disconnect();
}
```

Import `createTcpClient` from `mqtt`. Use the same limits with `createWebSocketClient`, `createBrowserClient` or `connectPortable`. The browser entry is `mqtt/browser`.

## Limits

| Option | Default | Meaning |
| --- | ---: | --- |
| maxPendingSubscriptions | 32 | Maximum reserved subscription exchanges, from 1 through 65,535 |
| maxPendingSubscriptionBytes | 1048576 | Sum of their complete encoded MQTT 5 SUBSCRIBE request sizes |

Both values must be safe integers within their stated range. The byte limit must be positive. Factories validate and capture the values when connection starts, before native resource acquisition. Mutating the caller's settings during opening does not change them. The custom packet client validates before listener registration.

An excess request rejects with a RangeError whose message is `MQTT subscription capacity exceeded`. It reserves no identifier, creates no operation timer and does not call the packet transport. There is no waiting queue. Other exchanges continue, and the caller may retry when capacity becomes available.

Ordinary filter validation runs first. An established terminal failure or an already-started disconnect retains its existing precedence. Validation can allocate temporary encoded strings and filter levels. These limits describe retained encoded request bytes and exchange count, not JavaScript heap usage or total allocation.

For the current one-filter, QoS 0 SUBSCRIBE profile, Remaining Length is six plus the filter's UTF-8 byte length. The complete charge adds the first header byte and Remaining Length encoding. It includes the packet identifier, zero Property Length, Topic Filter length and subscription options byte. The accounting excludes TLS/WS framing, broker properties, native queues and application-held data. Those resources have separate limits.

## Completion and failure

The client registers the reservation before sending, so a synchronous custom-transport SUBACK is safe. Only a SUBACK with the reserved identifier can complete its acknowledgment. Wrong identifiers and other packet kinds do not complete that subscription at the core seam. The first matching result wins, and the client snapshots its scalar result rather than retaining the entire broker packet.

A subscription retains its identifier and byte charge until both its actual send and matching acknowledgment settle. Neither an early SUBACK nor an early send callback releases capacity alone. This also applies to a refusal. The preview requests QoS 0 and requires exactly one zero grant for success. Other grants or an invalid result count reject with `MQTT acknowledgment refused` after send completion. They leave the session usable. This is the current preview policy; full protocol-error handling for malformed SUBACKs remains under #9.

A subscription send rejection can mean that bytes reached the peer. The client retires the session, rejects other operations with its first failure and requests forced closure. It does not reuse that session's identifiers. A timeout or connection failure also retires all pending subscription ownership. Graceful disconnect rejects unfinished exchanges. A late acknowledgment or send callback cannot reactivate the session.

Identifiers use the range 1 through 65,535. Allocation wraps and skips occupied identifiers. Each release owns its entry identity. An old callback cannot delete a newer entry after numeric identifier reuse. A local identity token cannot distinguish an arbitrary stale same-kind wire acknowledgment after legitimate reuse within one connection. This design assumes the peer follows MQTT exchange and ordering rules. Reconnect generation fencing remains separate work under #12.

The native [control reserve](native-write-reserve.md), [publication admission](outgoing-admission.md), subscription pool and ping response fence describe different resources. Concurrent subscriptions add no priority scheduler and cannot overtake an earlier native write. Publication remains QoS 0. A future QoS 1 operation needs its own negotiated quota, acknowledgment lifetime and shared identifier ownership under #10.

## Verification

The initial four regressions failed on the previous implementation. Focused tests cover both completion orders, reversed and wrong-kind replies, duplicate results, refusal, count/byte rejection, timeout, disconnect and uncertain sends. A full-range test keeps ID 1 occupied while allocation wraps and reuses ID 2. It also checks exhaustion and an old release after reuse. TCP, Node WS and browser wire fixtures independently exercise count and byte limits during mutable-option handoff. Packed Mosquitto fixtures run concurrent subscriptions through the installed public clients.

The SubscriptionOwnership model separates reservation, send completion, acknowledgment, successful release, old cleanup and terminal retirement. It uses three abstract identifiers and three lease identities, a two-entry limit, a three-unit byte budget and one- or three-unit request charges. It checks entry/byte bounds, ownership until completion, no early release, kind correlation and no new admission after retirement. Free-ID selection abstracts the numeric cursor. Concrete tests establish wraparound, UTF-8 arithmetic and the full identifier range.

The model assumes synchronous JavaScript state changes and conforming peer/session ordering. It checks safety without a liveness or scheduling guarantee. It excludes refusal codes, payload bytes, native buffers, physical closure and arbitrary stale same-kind wire frames after valid ID reuse. The existing lifecycle models retain their earlier scope. No performance measurements or speed claims accompany this change. #10 remains open for QoS 1, shared publish/unsubscribe IDs, Receive Maximum and cancellation semantics.
