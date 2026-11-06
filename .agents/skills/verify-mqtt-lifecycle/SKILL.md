---
name: verify-mqtt-lifecycle
description: Check the MQTT ping retirement and native WebSocket opening invariants when reviewing any PR in this repository.
---

# Verify MQTT lifecycle changes

For each PR, compare its diff with the coverage below. Run the checks and record whether the model is in sync, updated, exposes a bug, or is blocked. When a covered transition changes, compare the source with the model before changing the model. Update the sync commit only after rerunning the good and broken cases.

## Run

Use Java 11 or newer and the official TLA+ TLC 1.7.4 jar from https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4. Set TLC_JAR to the jar path. Set JAVA to the absolute executable path if java is absent from PATH. The runner verifies the published jar checksum.

Run from the repository root:

    node verification/check.mjs
    pnpm test test/portable.test.ts test/tcp-client.test.ts test/websocket.test.ts

The positive models must pass. Each broken configuration must fail on its named invariant. An error parsing the model or starting Java is a blocked run.

## Coverage

Product code sync commit: 630e9c8f6af9e25f56950ba5e2232ac2db6e49ca.

- PingFence covers src/portable.ts exchange, run, abort and fail. For one active connection with up to two pings, a timeout or failed write retires the connection before another request can reuse the acknowledgment slot. A reply from the first request cannot complete the second. Reply identity is a model label. MQTT PINGRESP carries no identifier. The model assumes at most one solicited reply per request and excludes unsolicited or duplicate replies.
- WebSocketOpen covers src/websocket.ts openMqttWebSocket and its open, failure and cleanup callbacks. One opening attempt transfers the socket to the caller or rejects and requests closure. Removing the open listener prevents a late open callback. The model groups abort, error, close, timeout and subprotocol rejection into failure. It assumes callback bodies run to completion.

The bounded models check safety. TCP/OS and browser socket teardown, timing bounds in a suspended page, transport buffering, MQTT sessions and durability need separate checks. WebSocketOpen's counter counts terminal handler effects. It does not measure physical socket closure.

## Falsification and replay

- PingFenceBroken allows reuse after failure. TLC finds an old reply that can complete the retry. PingFenceRetry finds the extra send first. The real TypeScript regression reproduced two PINGREQ packets on main by starting a retry three microtasks after the timer callback. It does not assert that the second promise resolved. The test also covers an admitted write that rejects.
- WebSocketOpenBroken leaves the open listener installed after failure. TLC finds two terminal handler effects. The real TypeScript test fails if openMqttWebSocket keeps its open listener after abort. Check listener removal before dispatching the late event.

Record tool version, state counts, mutation result, real-code test result and what remains outside the model in the PR review.
