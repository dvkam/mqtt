# Outgoing publication admission

The supported TCP, Node WebSocket, browser and custom packet clients limit outstanding QoS 0 publication sends before their operation deadlines. They reject excess work before calling the packet transport, encoding the payload or creating an operation timer. There is no waiting queue for rejected work.

| Option | Default | Meaning |
| --- | ---: | --- |
| maxPendingPublishes | 32 | Maximum unsettled publication sends |
| maxPendingPublishBytes | 1048576 | Sum of their complete MQTT 5 PUBLISH wire sizes |

Both options must be positive safe integers. Each factory validates and captures them when connect starts, before acquiring a socket. The custom client validates before registering its transport listener. Later changes to the caller's options do not change admission.

For example, pass `maxPendingPublishes: 8` and `maxPendingPublishBytes: 262144` alongside the existing factory options to permit up to eight unsettled sends within 256 KiB. Each publication must fit both limits. A capacity rejection is a RangeError with message `MQTT publication capacity exceeded`. It leaves the session active. An established terminal failure or an already-started disconnect keeps its existing precedence.

The byte count includes the first header byte, Remaining Length encoding, two-byte Topic Name length, UTF-8 Topic Name, zero Property Length and UTF-8 payload. The current publishing API uses QoS 0 and no properties. Payload lone surrogates count as replacement characters, matching the encoders. Counting stops once a string exceeds the available allowance and does not allocate an encoded payload. Ordinary topic validation still occurs first.

A reservation starts synchronously before transport work, including reentrant callbacks. It ends when that actual send promise settles or the send throws. An operation timeout retires the session but does not free a reservation for a still-pending send. A late completion releases only its original reservation and cannot reactivate the session. Applications may retry a capacity rejection after an earlier send settles. They must create a new factory after terminal failure.

Publication reservations do not consume the shared client's acknowledgment slot or disconnect path. A full publication pool therefore permits core control work. Native TCP and WebSocket writes retain their existing ordering; this change adds no scheduler and lets no control packet overtake a partial native write.

This pool measures unsettled packet-transport sends. Browser sends settle after native admission, so browser-owned queued bytes can outlive their publication reservations. maxBufferedBytes remains a separate WebSocket bound and can reject a control send. TCP callbacks, custom transport promises, native buffers, application-held strings and total process memory are distinct quantities. Custom adapters must report send settlement honestly; this pool cannot bound buffers they retain after settlement.

Native control-byte reservation, broader QoS ordering and the sustained mixed-packet soak remain under [#11](https://github.com/dvkam/mqtt/issues/11). Existing 8 MiB packed EOF validation opts into a 16 MiB publication budget to preserve that workload. It still asserts truncation and teardown rather than exercising the default admission limit. No performance claim or new benchmark measurement accompanies this change.
