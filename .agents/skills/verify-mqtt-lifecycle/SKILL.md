---
name: verify-mqtt-lifecycle
description: Check the MQTT ping retirement, WebSocket opening and session admission invariants when reviewing any PR in this repository.
---

# Verify MQTT lifecycle changes

For each PR, compare its diff with the coverage below. Run the checks and record whether the model is in sync, updated, exposes a bug, or is blocked. When a covered transition changes, compare the source with the model before changing the model. Update the sync commit only after rerunning the good and broken cases.

## Run

Use Java 11 or newer and the official TLA+ TLC 1.7.4 jar from https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4. Set TLC_JAR to the jar path. Set JAVA to the absolute executable path if java is absent from PATH. The runner verifies the published jar checksum.

Use the pinned development Node version from .node-version for the typed runner. Run from the repository root:

    node verification/check.ts
    pnpm test test/portable.test.ts test/tcp-client.test.ts test/websocket.test.ts test/websocket-client.test.ts test/browser-transport.test.ts test/codec.test.ts test/browser-client.test.ts test/browser-eof.test.ts test/message-queue.test.ts test/browser-message-stream.test.ts test/delivery-comparison.test.ts

The positive models must pass. Each broken configuration must fail on its named invariant. An error parsing the model or starting Java is a blocked run.

## Coverage

Product code sync commit: b8a47be675311bb8ae6de03710e5a736eda5b16f.

The explicit constructor fields and generic receive-payload types preserve the runtime transitions checked by the original session models. Node factories use named PortableOptions<NodeMessage>. Their listener checks the decoded QoS 0 Buffer contract before forwarding a publication to the existing lifecycle.

- PingFence covers src/portable.ts exchange, run, abort and fail. For one active connection with up to two pings, a timeout or failed write retires the connection before another request can reuse the acknowledgment slot. A reply from the first request cannot complete the second. Reply identity is a model label. MQTT PINGRESP carries no identifier. The model assumes at most one solicited reply per request and excludes unsolicited or duplicate replies.
- WebSocketOpen covers src/websocket.ts openMqttWebSocket and its open, failure and cleanup callbacks. One opening attempt transfers the socket to the caller or rejects and requests closure. Removing the open listener prevents a late open callback. The model groups abort, error, close, timeout and subprotocol rejection into failure. It assumes callback bodies run to completion.

- WebSocketSession covers src/portable.ts's CONNACK activation and delivery callback, and src/websocketClient.ts's send admission. One attempt can admit up to two abstract queue units. Accept maps to exchange completion with no recorded failure. Deliver maps to the active, non-closing callback guard. Admit maps to the bufferedAmount plus encoded packet size check. Close maps to logical retirement. It groups graceful closing and terminal states for delivery purposes. It does not bound frame overhead, parser allocations, kernel buffers, or total memory.

The bounded models check safety. TCP/OS and browser socket teardown, timing bounds in a suspended page, transport buffering, MQTT sessions and durability need separate checks. WebSocketOpen's counter counts terminal handler effects. It does not measure physical socket closure.

BrowserTransport sync commit: 9e63dbf66a94c79e741d1da6ad599244ce8f671f.

- BrowserTransport covers src/browserTransport.ts retirement, captured message delivery, send admission and native-close settlement. Its 48 states include two abstract admitted queue units, one captured callback, an observer that can throw, and local retirement, native-close or deadline actions. Callback bodies run to completion. It checks no delivery after retirement, bounded admission and native-close settlement despite observer failure. Deadline scheduling, actual socket termination, timer delays in suspended pages, listener counts, MQTT session validity and receive-memory bounds are outside this model. Opening handoff cancellation is checked by the TypeScript regression.

CodecFrames sync commit: ef59542a678dea487bc578af36c5c9963bfd735f.

- CodecFrames covers PacketDecoder.push in src/codec.ts. Declare maps to the validated size check followed by frame allocation. Copy maps to copying a bounded input slice and increasing offset. Emit maps to the offset/frame-length equality check. Reject maps to the catch block clearing frame/header and storing failure. FailedInput maps to the guard at the start of a later push. Five states use an abstract two-unit header, total sizes from two through five units and an allocation bound of three units. This finite model checks the control structure. It assumes header validation and abstracts byte arithmetic, string/property decoding, payload ownership, JavaScript allocation overhead and garbage collection. Concrete tests cover those wire rules and a caller-input mutation after fragmented delivery.

BrowserClientHandoff sync commit: b8a47be675311bb8ae6de03710e5a736eda5b16f.

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

On 7 November 2026, review checked b8a47be675311bb8ae6de03710e5a736eda5b16f against the prior synchronization commit. Named session and option types preserve the modeled control flow. The Node packet listener admits QoS 0 Buffer publications before passing them to the existing activation and retirement guards. It forwards acknowledgment objects unchanged. This is a concrete input precondition, not a new model transition or a proof of general packet conformance. Packet identity, Buffer mutability and unsupported-shape filtering have dedicated regressions. Replacing the real shape guard with an unconditional acceptance made the unsupported-publication regression fail; the guard was restored. All six positive models and all thirteen deliberately broken configurations retain their existing outcomes and bounds.

CodecEndOfInput sync commit: ef59542a678dea487bc578af36c5c9963bfd735f.

CodecFrames still describes frame admission, copying and emission before successful finish. Its Reject action also describes the frame/header cleanup and stored failure after truncated end of input. The new ended guard prevents entry to that framing logic after successful completion. No existing invariant or allocation bound changed.

CodecEndOfInput covers PacketDecoder.finish and the ended guard in push. Its five states derive from the source fields: open at a packet boundary, open with a partial header, open with a partial body, ended, and failed. Failure takes precedence over ended when deriving the phase. Begin and Complete abstract successive pushes that start or complete a packet. Finish maps to the header/frame check followed by stored failure and buffer cleanup, or setting ended. Reject maps to an ordinary push decode error. InputAfterEnd maps to a later push. FinishAfterFailure maps to the failure guard on a later finish.

The model checks RejectTruncatedEnd, NoOutputAfterEnd and PreserveFailure. PreserveFailure means completion cannot report success after an earlier failure. Exact Error object identity is checked by TypeScript regressions rather than modeled. Calls are sequential, byte reads use ordinary views, and packet contents, allocations, garbage collection, transport closure and reentrant input hooks are outside this model.

Run CodecEndOfInputTruncated, CodecEndOfInputOutput and CodecEndOfInputFailure as deliberately broken configurations. They must fail their named invariants. The real truncated-input regression fails when the completion header/frame guard is disabled. The post-completion regression fails when push omits its ended guard. The previous-failure regression fails when finish omits its stored-failure guard. All three real mutations were restored, and the full suite passed afterward.

The first broken-model run exposed an incomplete successor assignment caused by missing parentheses around a Boolean update. The runner rejected that error because it was not the expected invariant violation. The equation was corrected without changing any property or bound. The final seven positive models and sixteen deliberately broken configurations all produce their expected results.

The verification runner is now verification/check.ts. Its model cases use a readonly named tuple with an optional expected invariant, and the strict compiler and type-aware lint include the verification directory. The integrity regression passed against the original JavaScript before migration and against the typed runner afterward. Changing the expected checksum to accept the invalid jar made that regression fail. The published checksum was restored, and the test confirms rejection before a Java attempt. All seven positive models and sixteen deliberately broken configurations retained their outcomes after the port. No model property, bound or product source changed.

BrowserDecoderClose sync commit: d7419239711339020771ac8a5b292d2ea43ef7eb.

BrowserDecoderClose covers the composition of src/browserTransport.ts retirement and src/browserClient.ts decoder completion. Its ten states include open input at a packet boundary or inside a packet and one retirement with each of four causes. Begin and Complete abstract input fragmentation. Retire maps to the first-failure guard, listener removal and onClose notification. Completion runs during that notification. The remote-only branch selects a decoder truncation error; local, abort and error causes retain their initiating reason. Repeat maps to a later retirement attempt stopped by the same guard. partialAtClose is a history variable for the decoder state before finish clears buffered input.

RemoteTruncation checks that a remote retirement inside a packet reports truncation. PreserveOtherCause checks that other causes survive completion. FinishAtMostOnce checks that later retirements cannot repeat completion. The model uses cause categories rather than Error objects. Concrete tests check identity, refusal codes, timeouts and successful local disconnect. Opening failures before the byte transport owns input are outside this model. Browser event callbacks run to completion with promise jobs between native message and close tasks. A real native WebSocket test checks immediate refusal followed by partial trailing input and closure. Arbitrary synchronous nesting of synthetic message and close events is outside that scheduling assumption.

The model does not prove codec conformance, frame allocation limits, physical socket closure or wall-clock deadlines. Existing CodecEndOfInput, BrowserTransport and BrowserClientHandoff models retain their properties and bounds. Their source mappings remain valid. The additional close-kind argument classifies the same retirement paths; it does not introduce another delivery or settlement transition.

BrowserDecoderCloseOmit, BrowserDecoderCloseReplace and BrowserDecoderCloseRepeat must fail RemoteTruncation, PreserveOtherCause and FinishAtMostOnce respectively. The corresponding real-source mutations omit decoder.finish, apply truncation replacement to every close kind, or remove the first-retirement guard. Each mutation makes test/browser-eof.test.ts fail. All source mutations were restored. All eight positive models and nineteen broken configurations produce their expected outcomes.

MessageQueueOwnership and StreamTerminal sync commit: 55481c70ce3f41ee9e60f315068184ef3c0c3970.

These models describe the unpublished comparison prototype in test/experiments/message-queue.ts. Existing product source is unchanged from bfb0d4e822c731a714b0489053a39e2a5a8f6993, so the prior eight lifecycle models remain in sync with their recorded mappings. No property or bound was weakened.

MessageQueueOwnership explores 51 states with up to two queued messages, a three-unit data budget, message sizes one through four, one pending iterator request and two abstract protocol-control steps. Offer maps to push admission, direct delivery or queued copying. Read maps to shifting an entry and subtracting its weight. Wait maps to one pending next request. Close maps to source completion with queued drain. Stop maps to cancellation or iterator exit. Fail maps to source failure or overflow. The first source terminal signal wins; consumer cancellation may discard an existing drain.

BoundedQueue checks item and accounted-data admission. NoLateDelivery checks that later push calls cannot deliver or retain new application data after termination. BoundedWaiters checks the single pending iterator request. ConsumerDoesNotOwnProtocol checks that application stop does not retire the independent protocol reader. Control steps remain available while the facade is stopped; the model does not assert fairness or eventual protocol replies.

MessageQueueOwnershipBudget, MessageQueueOwnershipDelivery and MessageQueueOwnershipWaiter must fail their named invariants. Removing the real admission, post-stop push or pending-read guard makes the matching TypeScript regression fail. MessageQueueOwnershipCancel is a hypothetical incorrect wiring that gives application stop ownership of the protocol reader. It is not a mutation of this queue, which receives no session or socket capability. The real ownership evidence is that dependency separation plus Node-native and packed Chromium tests that continue SUBACK, PINGRESP and disconnect after cancellation or overflow.

StreamTerminal explores 24 states with one accepted message, one pull and an explicit suspension between iterator resolution and native controller notification. Pull maps to the callback before await. Resume maps to its continuation. Offer can resolve a waiting pull before that continuation executes. Close and Fail map to source terminal notification. Cancel represents native consumer cancellation. EmptyCompletion and FailureSettles check immediate notification of an empty normal close or failure, even with no read. PreserveHandedMessage checks that normal close does not close the controller before a message already handed to a pending pull is enqueued.

The original prototype left reader.closed pending at idle completion or failure. Concrete regressions reproduced that bug before terminal notification was added. A separate regression protects push followed by close before a pull resumes. StreamTerminalClose, StreamTerminalFailure and StreamTerminalHandoff must fail EmptyCompletion, FailureSettles and PreserveHandedMessage. Removing each source notification or the pulling guard makes its real regression fail. Every mutation was restored.

The new models assume sequential ordinary callbacks and native Streams controller semantics. They abstract payload contents, compact copying, string accounting, Error identity, consumer-created pending read promises, native stream internals, downstream transforms and heap overhead. Concrete tests cover those supported data and outcome contracts; no total-memory, network backpressure, full MQTT conformance or automatic source-end coupling is proved. The original protocol models retain their own narrower assumptions.

All ten positive models and twenty-six deliberately broken configurations produce their expected outcomes. Six corresponding queue and terminal source mutations fail their concrete regressions. Cancellation ownership is checked through the structural and integration evidence described above, rather than counted as a seventh source mutation.
