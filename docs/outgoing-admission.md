# Outgoing publication admission

The supported TCP, Node WebSocket, browser and custom packet clients limit outstanding QoS 0 sends and queued or active QoS 1 publications in one pool. They reject excess work before calling the packet transport, encoding the payload or creating an operation timer. A QoS 1 request that fits the pool can wait for broker quota.

| Option | Default | Meaning |
| --- | ---: | --- |
| maxPendingPublishes | 32 | Maximum pending publications |
| maxPendingPublishBytes | 1048576 | Sum of their complete MQTT 5 PUBLISH wire sizes |

Both options must be positive safe integers. Each factory validates and captures them when connect starts, before acquiring a socket. The custom client validates before registering its transport listener. Later changes to the caller's options do not change admission.

For example, pass `maxPendingPublishes: 8` and `maxPendingPublishBytes: 262144` alongside the existing factory options to permit up to eight unsettled sends within 256 KiB. Each publication must fit both limits. A capacity rejection is a RangeError with message `MQTT publication capacity exceeded`. It leaves the session active. An established terminal failure or an already-started disconnect keeps its existing precedence.

The byte count includes the first header byte, Remaining Length encoding, two-byte Topic Name length, UTF-8 Topic Name, zero Property Length and UTF-8 payload. QoS 1 adds two identifier bytes. Payload lone surrogates count as replacement characters, matching the encoders. Counting stops once a string exceeds the available allowance and does not allocate an encoded payload. Ordinary topic validation still occurs first.

A reservation starts synchronously before transport work, including reentrant callbacks. For QoS 0 it ends when that actual send promise settles or the send throws. QoS 1 retains its reservation through queueing, actual send and matching acknowledgment. The [QoS 1 guide](qos1-publish.md) covers cancellation and teardown. A timeout retires the session while a still-pending send keeps its reservation. A late completion releases only its original reservation. Applications can retry after capacity returns and create a new factory after terminal failure.

Publication reservations do not consume the client's subscription registry, unnumbered ping slot or disconnect path. A full publication pool therefore permits core control work. Native TCP and WebSocket writes retain their existing ordering; this change adds no scheduler and lets no control packet overtake a partial native write.

Browser sends settle after native admission, so browser-owned queued bytes can outlive their publication reservations. The separate [native write budget and control reserve](native-write-reserve.md) uses each supported adapter's observed queue. TCP callbacks, custom transport promises, native buffers, application-held strings and total process memory are distinct quantities. Custom adapters must report send settlement at their documented boundary.

Native admission now preserves control headroom for the supported clients. Broader QoS ordering and the sustained mixed-packet soak remain under [#11](https://github.com/dvkam/mqtt/issues/11). Existing 8 MiB packed EOF validation opts into 16 MiB publication and native budgets to preserve that workload. It still asserts truncation and teardown rather than exercising the default admission limits. No performance claim or new benchmark measurement accompanies this change.
