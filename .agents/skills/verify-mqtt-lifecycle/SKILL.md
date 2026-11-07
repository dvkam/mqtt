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
    pnpm test test/portable.test.ts test/tcp-client.test.ts test/websocket.test.ts test/websocket-client.test.ts test/browser-transport.test.ts

The positive models must pass. Each broken configuration must fail on its named invariant. An error parsing the model or starting Java is a blocked run.

## Coverage

Product code sync commit: 1446df4c4d49f82367267600fd3c6ba7455b050f.

- PingFence covers src/portable.ts exchange, run, abort and fail. For one active connection with up to two pings, a timeout or failed write retires the connection before another request can reuse the acknowledgment slot. A reply from the first request cannot complete the second. Reply identity is a model label. MQTT PINGRESP carries no identifier. The model assumes at most one solicited reply per request and excludes unsolicited or duplicate replies.
- WebSocketOpen covers src/websocket.ts openMqttWebSocket and its open, failure and cleanup callbacks. One opening attempt transfers the socket to the caller or rejects and requests closure. Removing the open listener prevents a late open callback. The model groups abort, error, close, timeout and subprotocol rejection into failure. It assumes callback bodies run to completion.

- WebSocketSession covers src/portable.ts's CONNACK activation and delivery callback, and src/websocketClient.ts's send admission. One attempt can admit up to two abstract queue units. Accept maps to exchange completion with no recorded failure. Deliver maps to the active, non-closing callback guard. Admit maps to the bufferedAmount plus encoded packet size check. Close maps to logical retirement. It groups graceful closing and terminal states for delivery purposes. It does not bound frame overhead, parser allocations, kernel buffers, or total memory.

The bounded models check safety. TCP/OS and browser socket teardown, timing bounds in a suspended page, transport buffering, MQTT sessions and durability need separate checks. WebSocketOpen's counter counts terminal handler effects. It does not measure physical socket closure.

BrowserTransport sync commit: 36995a31c2c4e7ffc89e517aa2bdf8bd8bcecf0e.

- BrowserTransport covers src/browserTransport.ts retirement, captured message delivery, send admission and native-close settlement. Its 48 states include two abstract admitted queue units, one captured callback, an observer that can throw, and local retirement, native-close or deadline actions. Callback bodies run to completion. It checks no delivery after retirement, bounded admission and native-close settlement despite observer failure. Deadline scheduling, actual socket termination, timer delays in suspended pages, listener counts, MQTT session validity and receive-memory bounds are outside this model. Opening handoff cancellation is checked by the TypeScript regression.

## Falsification and replay

- PingFenceBroken allows reuse after failure. TLC finds an old reply that can complete the retry. PingFenceRetry finds the extra send first. The real TypeScript regression reproduced two PINGREQ packets on main by starting a retry three microtasks after the timer callback. It does not assert that the second promise resolved. The test also covers an admitted write that rejects.
- WebSocketOpenBroken leaves the open listener installed after failure. TLC finds two terminal handler effects. The real TypeScript test fails if openMqttWebSocket keeps its open listener after abort. Check listener removal before dispatching the late event.

- WebSocketSessionDeliver admits application traffic outside the active phase. The real tests reproduce PUBLISH delivery before CONNACK and a captured callback after transport failure. WebSocketSessionBudget omits the admission guard. The real oversized write test fails when that guard is removed. The paused-peer comparison measures multi-write behavior separately.

- BrowserTransportDelivery, BrowserTransportBudget and BrowserTransportObserver must fail NoLateDelivery, BoundedAdmission and NativeCloseSettles respectively. Removing the actual delivery guard or budget guard makes test/browser-transport.test.ts fail. Before the observer fix, the real local-close and remote-close tests failed because the notification threw or native completion was skipped. Restore every deliberate defect before committing.

Record tool version, state counts, mutation result, real-code test result and what remains outside the model in the PR review.
