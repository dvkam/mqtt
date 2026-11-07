---
name: verify-mqtt-lifecycle
description: Check the MQTT ping retirement, WebSocket opening and session admission invariants when reviewing any PR in this repository.
---

# Verify MQTT lifecycle changes

For each PR, compare its diff with the coverage below. Run the checks and record whether the model is in sync, updated, exposes a bug, or is blocked. When a covered transition changes, compare the source with the model before changing the model. Update the sync commit only after rerunning the good and broken cases.

## Run

Use Java 11 or newer and the official TLA+ TLC 1.7.4 jar from https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4. Set TLC_JAR to the jar path. Set JAVA to the absolute executable path if java is absent from PATH. The runner verifies the published jar checksum.

Run from the repository root:

    node verification/check.mjs
    pnpm test test/portable.test.ts test/tcp-client.test.ts test/websocket.test.ts test/websocket-client.test.ts test/browser-transport.test.ts test/codec.test.ts test/browser-client.test.ts

The positive models must pass. Each broken configuration must fail on its named invariant. An error parsing the model or starting Java is a blocked run.

## Coverage

Product code sync commit: 9e63dbf66a94c79e741d1da6ad599244ce8f671f.

The explicit constructor fields and generic receive-payload types preserve the runtime transitions checked by the original session models. Node factory option extraction explicitly specializes IPublishPacket to retain its original payload declarations.

- PingFence covers src/portable.ts exchange, run, abort and fail. For one active connection with up to two pings, a timeout or failed write retires the connection before another request can reuse the acknowledgment slot. A reply from the first request cannot complete the second. Reply identity is a model label. MQTT PINGRESP carries no identifier. The model assumes at most one solicited reply per request and excludes unsolicited or duplicate replies.
- WebSocketOpen covers src/websocket.ts openMqttWebSocket and its open, failure and cleanup callbacks. One opening attempt transfers the socket to the caller or rejects and requests closure. Removing the open listener prevents a late open callback. The model groups abort, error, close, timeout and subprotocol rejection into failure. It assumes callback bodies run to completion.

- WebSocketSession covers src/portable.ts's CONNACK activation and delivery callback, and src/websocketClient.ts's send admission. One attempt can admit up to two abstract queue units. Accept maps to exchange completion with no recorded failure. Deliver maps to the active, non-closing callback guard. Admit maps to the bufferedAmount plus encoded packet size check. Close maps to logical retirement. It groups graceful closing and terminal states for delivery purposes. It does not bound frame overhead, parser allocations, kernel buffers, or total memory.

The bounded models check safety. TCP/OS and browser socket teardown, timing bounds in a suspended page, transport buffering, MQTT sessions and durability need separate checks. WebSocketOpen's counter counts terminal handler effects. It does not measure physical socket closure.

BrowserTransport sync commit: 9e63dbf66a94c79e741d1da6ad599244ce8f671f.

- BrowserTransport covers src/browserTransport.ts retirement, captured message delivery, send admission and native-close settlement. Its 48 states include two abstract admitted queue units, one captured callback, an observer that can throw, and local retirement, native-close or deadline actions. Callback bodies run to completion. It checks no delivery after retirement, bounded admission and native-close settlement despite observer failure. Deadline scheduling, actual socket termination, timer delays in suspended pages, listener counts, MQTT session validity and receive-memory bounds are outside this model. Opening handoff cancellation is checked by the TypeScript regression.

CodecFrames sync commit: 9e63dbf66a94c79e741d1da6ad599244ce8f671f.

- CodecFrames covers PacketDecoder.push in src/codec.ts. Declare maps to the validated size check followed by frame allocation. Copy maps to copying a bounded input slice and increasing offset. Emit maps to the offset/frame-length equality check. Reject maps to the catch block clearing frame/header and storing failure. FailedInput maps to the guard at the start of a later push. Five states use an abstract two-unit header, total sizes from two through five units and an allocation bound of three units. This finite model checks the control structure. It assumes header validation and abstracts byte arithmetic, string/property decoding, payload ownership, JavaScript allocation overhead and garbage collection. Concrete tests cover those wire rules and a caller-input mutation after fragmented delivery.

BrowserClientHandoff sync commit: 9e63dbf66a94c79e741d1da6ad599244ce8f671f.

- BrowserClientHandoff covers src/browserClient.ts's final signal check after connectPortable, and its packet transport close(force). Eight states describe one opening attempt and one forced retirement. Cancel represents the synchronous abort notification. Transfer checks cancellation before exposing the session. Force groups synchronous byte retirement and local promise completion without a native-close await. It assumes callback run-to-completion and promise jobs eventually execute. It does not prove a wall-clock deadline or physical socket closure. BrowserTransport separately covers byte retirement. The fake-timer client regression verifies that a ping timeout settles before a second native-close timer expires.

## Falsification and replay

- PingFenceBroken allows reuse after failure. TLC finds an old reply that can complete the retry. PingFenceRetry finds the extra send first. The real TypeScript regression reproduced two PINGREQ packets on main by starting a retry three microtasks after the timer callback. It does not assert that the second promise resolved. The test also covers an admitted write that rejects.
- WebSocketOpenBroken leaves the open listener installed after failure. TLC finds two terminal handler effects. The real TypeScript test fails if openMqttWebSocket keeps its open listener after abort. Check listener removal before dispatching the late event.

- WebSocketSessionDeliver admits application traffic outside the active phase. The real tests reproduce PUBLISH delivery before CONNACK and a captured callback after transport failure. WebSocketSessionBudget omits the admission guard. The real oversized write test fails when that guard is removed. The paused-peer comparison measures multi-write behavior separately.

- BrowserTransportDelivery, BrowserTransportBudget and BrowserTransportObserver must fail NoLateDelivery, BoundedAdmission and NativeCloseSettles respectively. Removing the actual delivery guard or budget guard makes test/browser-transport.test.ts fail. Before the observer fix, the real local-close and remote-close tests failed because the notification threw or native completion was skipped. Restore every deliberate defect before committing.

- CodecFramesAllocation, CodecFramesEarly and CodecFramesPoison must fail BoundedAllocation, CompleteBeforeEmit and NoOutputAfterFailure. Removing the real size guard, changing the emission equality to allow partial frames, or removing the stored-failure guard each makes test/codec.test.ts fail. Allocation uses an oversized declaration without a body. Completion uses fragmented vectors. Poison uses a valid PINGRESP after a rejected declaration. Restore each source mutation before continuing.

- BrowserClientHandoffAbort and BrowserClientHandoffForce must fail NoCancelledTransfer and ForceWithoutNativeWait. The real regression first reproduced successful connection handoff after abort. The forced-close regression first reproduced a ping still pending at its own timeout because it awaited a second close deadline. Both passed after the corresponding guards and local-force behavior were added.

Record tool version, state counts, mutation result, real-code test result and what remains outside the model in the PR review.

## Final review synchronization

On 7 November 2026, independent review compared all covered source with its previous synchronization commits. PR #46 at b54c1b1af94ce42d9d462b299ac59a5f884a1e4a retained those mappings. PR #47 at 9e63dbf66a94c79e741d1da6ad599244ce8f671f preserved the modeled transitions through the strict-type cleanup. The optional unlisten field permits a synchronous failure callback before registration returns; post-registration cleanup remains present.

Both exact revisions passed all six positive models and all 13 broken configurations. Removing one real guard for each model in isolated source snapshots made the corresponding regression suite fail on both revisions. Every mutation was restored. Later Vitest-rule, test-assertion and comment cleanup changes do not alter product transitions. No property, bound or assumption was weakened. The check outcomes are in sync.
