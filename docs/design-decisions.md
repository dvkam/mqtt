# Design decisions

This file records decisions about the public API and the package layout. The repository owner, dvkam, made each choice or accepted it by asking for the reviewed work to be merged, as the entry says. Unless an entry says otherwise, the questions were put to the owner in a working session outside GitHub, so this file is the first written record of the options and the trade-offs listed with them. In each table, "recommended" marks the option the question recommended. Nine of the ten choices with a recommendation followed it. The four entries for #147, #150, #161 and #152 were decided together. The three entries of 16 November were answered together, so their order among themselves means nothing.

Each entry gives the question, the options, the choice, the stated reason, any consequences the author of this file adds, and what follows. Several entries describe steps of the [#171 plan](https://github.com/dvkam/mqtt/issues/171#issuecomment-6912613511) that had not been merged when the entry was written. The status line says which.

To add a decision, put a new entry at the top with the same parts. Do not rewrite old entries. When a follow-up lands, append a line "Update, <date>: ..." to the entry. An earlier decision about the repository itself is in [base-decision.md](base-decision.md).

Two terms used below:

- The inbound rules are what the client does with each packet the broker sends: which packet types it accepts, how it shapes QoS 0 and QoS 1 messages, how it handles AUTH, and how it closes. At 351f172 the Node clients apply them in `src/nodePacketListener.ts` and `src/nodePacketInput.ts`, and the browser client has its own in `src/browserClient.ts` and `src/browserTransport.ts`.
- A packet-level seam is a public hook for a custom transport that sends and receives decoded MQTT packets instead of bytes.

## End the session on a PUBLISH the client cannot acknowledge, and hold the PUBREC of a duplicate

Written on 28 November 2026 (UTC), for [#148](https://github.com/dvkam/mqtt/issues/148) and for the open case of the QoS 2 entry below. Two reviews of the QoS 2 pull request found that a client without the handler for a QoS dropped a PUBLISH of that QoS without an acknowledgment, and that a resumed session could lose a QoS 2 message. The owner asked in a working session for both to be fixed and named the target behavior: a protocol error with DISCONNECT 0x82 for a PUBLISH above the handlers, the same end for every packet before CONNACK, and a PUBREC that waits for a handler of an earlier connection. The rule that `onQosTwoMessage` needs `onQosOneMessage` was proposed to the owner in that session, and the owner did not object. The owner has not explicitly accepted it. The other options below were not put to the owner as a question. The pull request author chose among them, and the owner has not accepted them yet. Status: in the pull request for `fix/inbound-acknowledgements`, not merged when this entry was written.

Question: what does a client do with a QoS 1 or QoS 2 PUBLISH that it has no handler for?

| Option | Trade-off |
| --- | --- |
| End the session with `ERR_MQTT_PROTOCOL` and DISCONNECT 0x82 (chosen) | The application learns at once that messages arrive which it cannot take. MQTT-4.5.0-2 requires an acknowledgment for every PUBLISH, and the broker is told why the connection ends. A session that used to stall without an error now ends. |
| Acknowledge the PUBLISH and discard the message | MQTT-4.5.0-2 allows an acknowledgment "regardless of whether it elects to process the Application Message". The session would go on, and every such message would be lost without a trace, at a QoS that promises delivery. |
| Drop the PUBLISH without an acknowledgment, as before | The broker's send quota fills, delivery of every QoS 1 and QoS 2 message stops, and nothing reports it. It breaks MQTT-4.5.0-2. |

Reason given by the pull request author: a QoS 1 or QoS 2 message that no code receives must not look delivered, and a stalled session is worse than an ended one. Reason code 0x82, Protocol Error, is one that MQTT 5 section 3.14.2.1 lets a client send, and 0x9B, QoS not supported, is for the server only. 0x83, Implementation specific error, was the other candidate. 0x82 fits the case the client can prove, which is a broker that delivers above the granted QoS against MQTT-3.8.4-8.

Question: may a client set `onQosTwoMessage` without `onQosOneMessage`?

| Option | Trade-off |
| --- | --- |
| No. `connect()` rejects with `ERR_MQTT_INVALID_ARGUMENT` before the transport opens (chosen, proposed to the owner and not objected to) | The handlers then give one number, the highest QoS the client acknowledges, and `subscribe` already required both handlers for `qos: 2`. A caller that set only `onQosTwoMessage` must add a handler. |
| Yes, and a QoS 1 PUBLISH ends the session | It keeps existing callers working until a publisher uses QoS 1 on a topic they subscribed to at QoS 2. That is a failure in production that the options could have shown at start. |

Question: how does a resumed session learn that its subscriptions need a handler the new client lacks?

| Option | Trade-off |
| --- | --- |
| The session state records the highest QoS that a SUBACK granted, and `connect()` with Clean Start false rejects with `ERR_MQTT_INVALID_ARGUMENT` before the transport opens (chosen) | One number in the state and one comparison per connection. The mistake shows before any packet, as the other session options do. The record does not fall when a subscription ends, so a client that unsubscribed from its only QoS 2 filter still needs both handlers to resume. |
| Reject after CONNACK with `ERR_MQTT_SESSION_CONFLICT` | It rejects only when the broker really resumed the session. That code tells a reconnecting client to retry, and a retry cannot add a handler, so the client would retry until its attempts run out. |
| Record each filter with its granted QoS | Exact for the subscriptions the state has seen, and it falls after an unsubscribe. It costs memory per subscription and still misses the subscriptions below. |
| No record. The first PUBLISH above the handlers ends the session | Nothing to store. The error then blames the broker for a mistake in the client's options. |

Reason given by the pull request author: the chosen record is the smallest one that turns the common mistake into an argument error. No record in the client is complete. The state does not know a subscription of another process under the same Client Identifier, of an earlier process whose state is gone, one whose SUBACK never arrived, or one the broker assigned. For those the first PUBLISH above the handlers still ends the session with DISCONNECT 0x82, and [Error codes](errors.md#gaps) lists the case.

Question: what does a resumed session do with the duplicate of a QoS 2 PUBLISH whose handler an earlier connection started and that still runs?

| Option | Trade-off |
| --- | --- |
| Hold the PUBREC until that handler settles, in the one receive slot (chosen, as the owner asked) | The broker cannot finish the exchange before the handler fulfilled, so a handler that fails gets the message again, and no second message arrives beside a running handler. A handler that never settles ends each connection that waits for it at the operation deadline. |
| Send PUBREC at once, as before | The session moves on while the old handler runs. A handler that fails afterwards loses the message, and nothing reports it. In a fuzz run of the review, every lost message came through this path. |
| Call the handler again at once | No wait, and two calls for one delivery run at the same time. |

Consequences, added by the pull request author:

- A session that stalled now ends. A client without `onQosOneMessage` that received a QoS 1 PUBLISH kept running and got no further QoS 1 or QoS 2 message. It now ends with `ERR_MQTT_PROTOCOL`, and a reconnecting client stops with the reason `fatal`.
- A packet other than CONNACK before CONNACK ends the attempt for every QoS and handler set. Before, a QoS 0 PUBLISH, an acknowledgment or a PINGRESP before CONNACK was ignored and `connect()` succeeded. The error of a QoS 1 or QoS 2 PUBLISH before CONNACK is now a `ProtocolInputError` with reason 0x82. Its message changed to `MQTT PUBLISH arrived before CONNACK`.
- The client still sends no DISCONNECT before CONNACK. MQTT 5 section 4.13.1 says a client SHOULD send one with the reason code and section 3.1.4 lets a client send packets before CONNACK, so the text allows the DISCONNECT and does not require it. The documented behavior stays, as for every other protocol error in that phase.
- A DISCONNECT before CONNACK keeps its own outcome, `ERR_MQTT_BROKER_DISCONNECT` with the broker's reason code, although MQTT-3.2.0-1 forbids the packet. The reason code tells a reconnecting client whether to retry.
- A PUBREL for a publication whose handler still runs is a protocol error with reason 0x82 on every connection of the session. Before, that held only for a handler of the current connection, and the PUBREL for a handler of an earlier connection got PUBCOMP.
- The duplicate that waits takes the receive slot of its connection. A broker that sends a second QoS 1 or QoS 2 PUBLISH beside it gets DISCONNECT 0x93. Before, identifiers of earlier connections never held the slot.
- The packet listener of a transport no longer filters by handler. It forwards a PUBLISH of every QoS, and the session decides.

What follows: [Inbound QoS 1](qos1-receive.md#a-publish-the-client-cannot-acknowledge) states the rule for a PUBLISH above the handlers, and [QoS 2](qos2.md#handler-failures) the held PUBREC. A journal for #14 has to store the granted QoS with the session.

## QoS 2 in both directions

Written on 28 November 2026 (UTC), for [#13](https://github.com/dvkam/mqtt/issues/13). The owner asked in a working session for QoS 2 on an active process. The request named both exchange directions, duplicate PUBLISH and PUBREL, a failed PUBREC that frees its quota slot, replay by phase after a resume and no second local delivery. The request left the handler shape, the delivery point, the meaning of PUBCOMP reason 0x92 and the content of the public codec to the pull request. The options below were not put to the owner as a question. The pull request author chose among them, and the owner has not accepted them yet. Status: in the pull request for `feat/qos2`, not merged when this entry was written.

Question: how does an application receive QoS 2 messages?

| Option | Trade-off |
| --- | --- |
| A new `onQosTwoMessage` handler with a `QosTwoMessage` type (chosen) | It mirrors `onQosOneMessage`, so each handler has one literal `qos` and existing callers change nothing. A QoS 2 subscription also delivers QoS 1 publications at QoS 1, so `subscribe(topic, { qos: 2 })` requires both handlers and rejects otherwise. |
| One handler for QoS 1 and QoS 2 | One option to set, but `onQosOneMessage` promises `qos: 1` in its type, so widening it breaks callers, and a second combined handler would give QoS 1 two ways in. |
| Require only `onQosTwoMessage` for a QoS 2 subscription | Fewer options for a caller whose publishers all use QoS 2. A QoS 1 publication on that subscription would then get no PUBACK, and with Receive Maximum 1 it would block every later QoS 1 and QoS 2 delivery. |

Reason given by the pull request author: the separate handler keeps the public types exact and adds no break, and the two-handler rule fails at `subscribe` instead of stalling the broker later.

Question: what does a session end report for a QoS 2 publication in flight?

| Option | Trade-off |
| --- | --- |
| `UncertainPublication` gains `qos`, and `acknowledged` is true once a PUBREC below 0x80 arrived (chosen) | One flag keeps one meaning at both QoS levels, which is that the broker accepted the publication. With `qos: 2` it also tells the phase, because an accepted QoS 2 publication continues with PUBREL and any other with PUBLISH. Existing readers of `acknowledged` keep working. |
| A separate `phase` field | It names the phase directly, but it repeats what `qos` and `acknowledged` say, and QoS 1 entries would need a value that means nothing for them. |

Reason given by the pull request author: the existing flag already answered whether the broker has the message.

Consequences, added by the pull request author:

- The client records the Packet Identifier of an inbound QoS 2 PUBLISH before the handler runs and sends PUBREC after the handler fulfills. MQTT 5 section 4.3.3 also allows storing the message and delivering it at PUBREL. That costs memory per message and delays delivery until the second round trip. Recording after the handler would let a duplicate PUBLISH on a later connection start a second handler call while the first still runs. A handler that fails removes its own delivery, so a resumed session delivers the message again with `dup: true`. Each delivery has a token, so a handler that settles after its connection ended cannot change a later message that got the same Packet Identifier. One case stays open. A handler that fails after a later connection already answered the duplicate does not get the message again.
- The publish promise resolves on PUBCOMP with reason 0 or 0x92. Reason 0x92 says the broker no longer knows the identifier, which happens when it released the message and its first PUBCOMP was lost. The PUBREC had accepted the message by then, so the client does not report a failure.
- A PUBREC with a reason of 0x80 or above rejects the publish with `ERR_MQTT_REFUSED` and `fatal: false`, as a refused PUBACK does. No new error code was added.
- A second PUBREC for an exchange and a PUBCOMP without an exchange are ignored, as an unmatched PUBACK is. A PUBREC below 0x80 for an identifier without an exchange gets PUBREL with reason 0x92, and a PUBREL for an unknown identifier gets PUBCOMP with reason 0x92, because MQTT 5 defines that reason for both packets. A PUBREL that arrives while the handler still runs is a protocol error with reason 0x82.
- The reconnecting client reports a continued QoS 2 exchange through two new event kinds, `pubrec` and `pubcomp`, with the fields of the `puback` event. A `switch` over `event.kind` without a `default` branch no longer compiles as exhaustive.
- `SubscribeOptions.qos`, `SubscribeResult.grantedQos` and `SubscriptionIntent.qos` widen to `0 | 1 | 2`. A SUBACK that grants less than the request resolves with the granted QoS. Before, a QoS 1 request resolved only with a grant of 0 or 1, which is the same rule.
- The public `mqtt/codec` entry now encodes and decodes QoS 2 PUBLISH, PUBREC, PUBREL and PUBCOMP, so `ClientPacket` and `BrokerPacket` gain three commands. The session needs the encoder, and a codec that decodes four packets it cannot encode would give a custom broker test double no way to answer. The codec still tracks no exchange.
- QoS 2 is not an opt-in import. `publish(topic, payload, { qos: 2 })` is a runtime option, so a bundler cannot drop the exchange code, and every client carries it. [QoS 2](qos2.md#cost) has the measured size.
- The drain deadline message changed from `MQTT QoS 1 drain expired. Delivery outcome is unknown` to `MQTT publish drain expired. Delivery outcome is unknown`, because one error now rejects QoS 1 and QoS 2 publications. The code stays `ERR_MQTT_TIMEOUT`.
- The session state keeps the phase of each outbound QoS 2 exchange and the inbound identifiers that wait for PUBREL. It drops the payload of a publication when its PUBREC arrives.
- A resumed session sends every stored PUBREL whatever the broker's Receive Maximum is, because MQTT 5 section 4.9 lets the quota hold back only PUBLISH packets. The exchanges still fill quota slots, so a PUBLISH waits for their PUBCOMPs.
- A PUBCOMP ends an exchange only once the client handed its PUBREL to the transport. An earlier one is ignored, so the exchange stays stored and a later connection finishes it.
- The client answers no PUBREC and no PUBREL once `disconnect()` was called, also during the drain. MQTT-4.3.3-4 and MQTT-4.3.3-11 ask for those answers, so [QoS 2](qos2.md#known-limit) lists this as a known limit.

What follows: [QoS 2](qos2.md) is the guide. The journal that survives a process restart is #14, and it has to store the same phases and inbound identifiers. The session binding reports each step of an inbound delivery, so a journal can store a Packet Identifier when the handler fulfilled and not before.

Update, 28 November 2026: the entry above this one closes the open case of the first consequence. A resumed session now holds the PUBREC of the duplicate until the handler of the earlier connection settles. It also makes `onQosTwoMessage` without `onQosOneMessage` an argument error, where this entry required both handlers only at `subscribe`.

## Target ES2025 and support Node 26 only

Decided on 26 November 2026 (UTC), for [#55](https://github.com/dvkam/mqtt/issues/55) and the compile target item of [#159](https://github.com/dvkam/mqtt/issues/159). The owner gave this instruction in a working session, and no question with options preceded it, so the table marks no recommended option. Earlier that day the owner had asked for a newer ECMAScript version so that library code can call `findLast`, and [#189](https://github.com/dvkam/mqtt/pull/189) raised the target from ES2020 to ES2023. The owner then wrote: "why not use es2025? ... set to supported node version only stable lts v26 and consumer checks ... move to es2025". [#192](https://github.com/dvkam/mqtt/pull/192) made that change. Status: #189 and #192 merged on 26 November 2026.

Question: which ECMAScript version does the build target, and which Node versions does the package support?

| Option | Trade-off |
| --- | --- |
| ES2020 output and Node 22.12, 24 and 26, as before | The widest reach. Library code cannot call a method newer than ES2020, and CI keeps a consumer job for Node 22 and 24. |
| ES2023 output and the same Node range, as #189 left it | Node 22.12 runs all of ES2023, so `findLast` is usable. ES2024 and ES2025 methods are not. |
| ES2025 output and Node 26 only (chosen) | Library code may call Set methods, iterator helpers and `Promise.try`. An install on Node 22 or 24 fails under `engine-strict` and warns without it. A browser needs Chrome 136, Firefox 138 or Safari 26 for every ES2025 feature. |

Reason given by the owner: the library should be modern and fast, and it has no consumers yet, so the baseline can still change.

Consequences, added by the pull request authors:

- `tsconfig.json`, the consumer type fixtures and the packed consumer use ES2025. The browser fixtures use ES2025 with DOM. [Toolchain verification](toolchain-baseline.md#toolchain-verification) records the browser versions.
- The `lts-consumers` CI job for Node 22 and 24 is gone, and the packed-consumer job installs the tarball with `--engine-strict`.
- At 8398718 the 52 emitted JavaScript files are byte for byte the same with `target` ES2023 and with ES2025, so the higher target adds no syntax to the output yet.
- ES2022 and later output keeps class fields as native fields. The optional `MqttError` fields use `declare`, so an error without a reason code has no `reasonCode` key.
- #192 set `engines.node` to `^26.0.0`. Every CI job runs the Node version in `.node-version`, 26.13.0, and #55 asks that the declared minimum minor is a tested one. [#198](https://github.com/dvkam/mqtt/pull/198) therefore narrows `engines.node` to `^26.13.0`. The pull request author recommended the narrowing. On 28 November 2026 the owner answered "go with all your recommendations" to a question that named the `^26.13.0` range. A CI job on an earlier Node 26 minor would let the range widen again.

What follows: the scheduled browser job has not run since the target left ES2020, so CI has not yet loaded this output in Chromium, Firefox and WebKit, which #159 asks for.

## Resume a session with an in-memory session state

Decided on 26 November 2026 (UTC), for [#12](https://github.com/dvkam/mqtt/issues/12) and the first part of [#14](https://github.com/dvkam/mqtt/issues/14). The owner asked in a working session for in-process session resumption to be built: the Clean Start and Session Expiry options, a session state with a small interface, both Session Present mismatches, the smaller packet limit on resume and an explicit session reset. The request proposed that a resent publication does not settle its original publish promise and that the reconnect events report its outcome. The options below were not put to the owner as a question. The pull request author chose among them, and the owner has not accepted them yet. Status: in the pull request for `feat/session-resume`, not merged when this entry was written.

Question: where does the client keep the QoS 1 publications that a resumed session must send again, and who can reach them?

| Option | Trade-off |
| --- | --- |
| A public opaque `SessionState` from `createSessionState()`, passed as the `sessionState` factory option, with an internal store interface behind it (chosen) | Each factory reaches the state through a typed option, so a one-shot factory can resume too, and a caller's `create` function passes it on as it passes `onSessionEnd`. Callers can read `inFlight`. The type carries a brand under a unique symbol that the package does not export, so callers cannot build one, and the client also checks at runtime that `createSessionState()` made it. #14 can change the internal store without a break. |
| Keep the state inside `createReconnectingClient` and pass it to the factory through a hidden channel, such as a symbol key or a map keyed by the attempt's `onSessionEnd` | No new public type, but the channel breaks without notice when a caller's `create` function copies the options field by field, and one-shot factories cannot resume. |
| A public store interface that callers implement | A caller could persist the state now, but the synchronous interface would not fit the fenced, asynchronous journal that #14 needs, so #14 would break it. |

Reason given by the pull request author: the explicit option keeps the factories self-contained and leaves the store interface free for #14.

Consequences, added by the pull request author:

- The internal `SessionBinding` in `src/sessionState.ts` holds the in-memory `Map` from Packet Identifier to the publication and the steps that use it: claim, resume, record, settle, forget and drop. Only `bindSessionState` builds one, so a bundle that never imports `createSessionState` or `createReconnectingClient` leaves those steps out. A connection records a copy of each QoS 1 publication before its first write and deletes it when its PUBACK arrives. Copying keeps the payload safe after the publish promise settles, and costs 380 to 470 sampled heap bytes per QoS 1 publish in an in-memory benchmark with a 16-byte payload, only when `sessionState` is set.
- The state is claimed before the transport opens and released when the open fails, so a state that another connection holds rejects without opening a transport. `cleanStart: false` needs a `sessionState`, because MQTT-3.2.2-4 makes a client without session state close on Session Present true.
- Resends go out one at a time, each after the write of the one before it settled. New QoS 1 publications stay queued, unstored and cancelable, and new QoS 0 publications wait before their write deadline starts, until every resend was written. Then the QoS 0 publications go out, followed by the QoS 1 publications in call order. MQTT orders publications only within one QoS level. The default publication write budget, 1 MiB minus the 128 KiB control reserve, is smaller than the default admission limit of 1 MiB, so stored publications written back to back could exceed it. On TCP and `ws`, where a write settles once the socket took the bytes, the wait keeps one resend at a time in the native buffer, so memory stays bounded by one stored publication and nothing is written twice on one connection. The pull request author chose this over exempting resends from the budget, which could fill the native buffer past the control reserve and then end the session on its next PUBACK. A resend the budget still refuses, such as one larger than the budget or one behind a browser `bufferedAmount` that has not drained, ends the connection with `ERR_MQTT_SESSION_CONFLICT`. The publication keeps its Packet Identifier in the state, and `resetSession()` is the remedy when the refusal repeats.
- `createReconnectingClient` gains `resume`, which reads `sessionExpiryInterval` from the factory options and replaces `cleanStart` and `sessionState` on each attempt. The `connected` event gains `resumed`, `resent` and `dropped`, and a new `puback` event reports the broker's answer to each resent publication. `client.resetSession()` makes the next attempt start a new session.
- A resent publication does not settle its original publish promise, which rejected when its session ended. Its outcome arrives in the `puback` event.
- A stored publication larger than the new Maximum Packet Size, a retained stored publication when CONNACK sets Retain Available 0, or a broker whose Maximum QoS is now 0 ends the connection with the new code `ERR_MQTT_SESSION_CONFLICT` before any PUBLISH. The client writes DISCONNECT with reason 0, which the error carries as `reasonCode`, so the broker keeps the session and does not publish the Will. The reconnecting client retries this code within `maxAttempts`, and the stored publications stay for a later resume or a reset.
- `cleanStart`, `sessionExpiryInterval` and `sessionState` reject with `ERR_MQTT_INVALID_ARGUMENT`, as the Will and the password do, and not with the `RangeError` of the numeric options.
- The client still sends no Topic Alias and advertises a Topic Alias Maximum of 0, so no alias map exists to carry over.

What follows: the fenced journal that survives a process restart is #14, which waits for QoS 2 in #13. The finite models in `verification/` still assume Clean Start true.

Update, 28 November 2026: [#196](https://github.com/dvkam/mqtt/pull/196) merged this work on 27 November 2026. In the working session of 26 November the owner had asked for it to follow the same flow as the reconnect work, which merges once review and CI pass. The options above were still not put to the owner as a question.

## Check a reconnecting client from an optional page lifecycle adapter

Decided on 26 November 2026 (UTC), for [#32](https://github.com/dvkam/mqtt/issues/32). The options below were not put to the owner as a question, and the owner did not choose among them. The pull request author chose the API. The owner accepted the choice by asking for the reviewed work to be merged. This entry and the next were decided together. Status: in the pull request for `feat/page-lifecycle`, not merged when this entry was written.

Question: how does a reconnecting client in a browser notice a stale connection, and skip its backoff, when the page comes back?

| Option | Trade-off |
| --- | --- |
| `watchPageLifecycle(client, options)` in `mqtt/browser`, which pings on return and calls a new `retryNow()` (chosen) | The clients listen for no page event, and a bundle without the import does not grow. `ReconnectingClient` gains one method. A stale session ends only at its ping deadline, and a session that answers slower than `timeoutMs` ends too. |
| The reconnecting client listens for page events itself | No extra import, but every browser bundle and every Node process carries browser event code. |
| The application aborts the client's `signal` on hide and builds a new client on return | No API change, but each return builds a new client, so the old client's uncertain publications never reach a connected event. |

Reason given by the pull request author: #32 asks to keep page and navigation events in the playground or an optional browser adapter. A ping is the only check that works without knowing how long the device slept, because `performance.now()` can leave sleep out.

Consequences: `retryNow()` counts its attempt toward `maxAttempts` and does nothing unless the client waits for its timer. The adapter reports each return to `onReturn` with the elapsed monotonic time. `checkAfterMs`, 0 by default, lets an application skip the check after a short absence. The ping cannot have its own deadline, because only the session can end itself and its deadline is `timeoutMs`. [Page lifecycle](page-lifecycle.md) lists what was checked in Chromium and the gaps.

What follows: Firefox and WebKit lifecycle tests, and the playground panel in #191.

Update, 28 November 2026: [#195](https://github.com/dvkam/mqtt/pull/195) merged this work on 26 November 2026.

Update, 28 November 2026: the `browsers` CI job runs the lifecycle check in Chromium, Firefox and WebKit, and the hidden tab check hides, throttles, freezes and discards a Chromium tab. No check failed in the adapter, so the adapter did not change. Playwright's Firefox and WebKit builds do not use the back-forward cache, so their cache stays a manual check. One measured limit follows from this decision. When a return finds an attempt open, the adapter does nothing, and after the overdue deadline ended that attempt the client waits its backoff delay. Whether the next attempt should start at once in that case is an open question for the owner, and this pull request does not answer it. The reviewer sketched a one-shot flag in the reconnecting client, which `retryNow()` sets when it is called while an attempt opens and which the client uses once to skip the delay after that attempt fails. It would change the documented contract of `retryNow()`, and a tab that flaps while the broker is down would use up `maxAttempts` faster. [Page lifecycle](page-lifecycle.md) has the measurements and the manual checks.

## Leave the connection open when the page enters the back-forward cache

Decided on 26 November 2026 (UTC), for [#32](https://github.com/dvkam/mqtt/issues/32), together with the previous entry and accepted the same way. Status: in the pull request for `feat/page-lifecycle`, not merged when this entry was written.

Question: what does the adapter do on a `pagehide` whose `persisted` is true?

| Option | Trade-off |
| --- | --- |
| Leave the connection, and check it on `pageshow` (chosen) | The adapter keeps the reconnecting client. Chromium 158 keeps the page in the cache with its WebSocket and fails the socket on restore. The broker counts the client as connected until then, and publishes the Will when the connection ends. |
| Disconnect on `pagehide` | The broker receives DISCONNECT. A reconnecting client cannot connect again after a disconnect, so the adapter would have to build a new client on `pageshow`. |
| Abort the connection on `pagehide` and resume on `pageshow` | Needs a pause state in the reconnecting client, which has none. |

Reason given by the pull request author: in Chromium, the only engine the author could run, an open WebSocket did not keep the page out of the cache, so a disconnect would gain no cache eligibility there. An application that needs DISCONNECT can disconnect in its own `pagehide` handler.

What follows: the same check in Firefox and WebKit, where an open WebSocket may block the cache or close at another time.

Update, 28 November 2026: [#195](https://github.com/dvkam/mqtt/pull/195) merged this work on 26 November 2026.

## Reconnect with a supervisor that builds a factory per attempt

Decided on 26 November 2026 (UTC), for [#12](https://github.com/dvkam/mqtt/issues/12). The owner asked in a working session for reconnect to be built and merged once review and CI passed. The options below were not put to the owner as a question, and the owner did not choose among them. The pull request author chose the API. The owner accepted the choice by asking for the reviewed work to be merged. Status: in the pull request for `feat/reconnect`, not merged when this entry was written.

Question: how does a caller keep a connection when each factory opens one session?

| Option | Trade-off |
| --- | --- |
| `createReconnectingClient(create, options, reconnect)`, which calls a factory function for each attempt and hands out each session (chosen) | The factories and their promise identity stay unchanged, and a connected session adds no work per publish. A caller must call `session()` again after an end. |
| A stable facade that forwards `publish` and the other calls to the current session | One object to hold, but every call goes through a wrapper, session boundaries are hidden, and calls made while disconnected need a new error code. |
| Let a factory's `connect()` open again after its session ends | Breaks the documented rule that repeated `connect()` calls return the same promise. |

Reason given by the pull request author: #12 asks for explicit session outcomes and no replacement publish, which a facade would hide.

Consequences: `SessionEnd` gains an optional `uncertain` list of QoS 1 publications that were in flight, without their payloads, so the event stays readonly. The retry and stop lists in [reconnecting](reconnect.md) are the pull request author's choice too, and the owner accepted them the same way. Every attempt opens a clean session.

What follows: resuming a session with Clean Start false is #14. Page lifecycle events in the browser are #32.

Update, 26 November 2026: the pull request for `feat/session-resume` adds the `resume` option, so later attempts can send Clean Start false and share one session state. [Resume a session with an in-memory session state](#resume-a-session-with-an-in-memory-session-state)

Update, 28 November 2026: [#190](https://github.com/dvkam/mqtt/pull/190) merged this work on 26 November 2026, and [#196](https://github.com/dvkam/mqtt/pull/196) merged the `resume` option on 27 November 2026.

## Publish takes bytes, retain and the MQTT 5 PUBLISH properties

Decided on 26 November 2026 (UTC), for [#151](https://github.com/dvkam/mqtt/issues/151). The owner proposed the design in the "Proposed fix" section of #151. On 26 November, in a working session, the owner asked for the work to be merged once review and CI passed. Status: in the pull request for `feat/publish-bytes-properties`, not merged when this entry was written.

Question: how does a caller publish bytes, set retain and attach MQTT 5 properties?

| Option | Trade-off |
| --- | --- |
| `publish(topic, string \| Uint8Array, options)` with retain and the PUBLISH properties in `PublishOptions` (chosen, recommended in #151) | One call for text and bytes. A received message can be passed back as the options. `PublishOptions` changes from a QoS union to one interface. |
| A separate `publishBytes` method | Keeps the old signature, but splits the API and its option checks. |

Reason given in #151: callers cannot send bytes, retain or properties, and a lone surrogate silently changes on the wire.

Consequences: a string with an unpaired surrogate, an invalid property and `retain` without broker support each reject with `ERR_MQTT_INVALID_ARGUMENT` before admission. A QoS 0 publish honors a signal that is already aborted. Admission counts the property section. The client keeps a reference to a byte payload and to Correlation Data until it writes the PUBLISH, so callers must not change them before the publish settles. #151 does not say whether to copy.

What follows: the client does not yet check a PUBLISH against the broker's Maximum Packet Size from CONNACK.

Update, 26 November 2026: the pull request for `fix/maximum-packet-size` checks each PUBLISH, SUBSCRIBE and UNSUBSCRIBE against the broker's Maximum Packet Size. A larger packet rejects with `ERR_MQTT_CAPACITY` and `fatal: false` before the publication or subscription takes a slot, and before anything is written. [Outgoing admission](outgoing-admission.md#maximum-packet-size)

Update, 28 November 2026: [#188](https://github.com/dvkam/mqtt/pull/188) merged this work on 26 November 2026, and [#194](https://github.com/dvkam/mqtt/pull/194) merged the Maximum Packet Size check on 27 November 2026.

## Every client accepts a text or byte password

Decided on 26 November 2026 (UTC), for [#146](https://github.com/dvkam/mqtt/issues/146). The owner's comment on #146 described the browser change only. Widening the Node and custom transport types goes further than that comment and was not put to the owner as a separate question. On 26 November, in a working session, the owner asked for the work to be merged once review and CI passed. Status: in the pull request for `feat/browser-password`, not merged when this entry was written.

Question: how does a browser application pass a password, and where is it checked?

| Option | Trade-off |
| --- | --- |
| Add `password: string \| Uint8Array` to the browser options only, as the #146 comment described | The smallest change, but the browser converts text on its own and the Node clients still check the length only in the encoder, after the socket opens. |
| Accept text or bytes in the shared core for every client and check it before `open` (chosen) | One rule for TCP, `ws`, the browser and custom transports. `TcpClientOptions`, `WebSocketClientOptions` and `ByteClientOptions` widen from `Uint8Array` to `string \| Uint8Array`. |

Reason given by the pull request author: the core already owns the other option checks that run before I/O, and one accepted type for every client is simpler than a browser-only conversion. The owner accepted the choice by asking for the reviewed work to be merged.

Consequences: a password over 65,535 bytes or of another type rejects `connect()` with `ERR_MQTT_INVALID_ARGUMENT` before the transport opens. The core copies the bytes, so a later change to the caller's array does not reach the wire. MQTT 5 allows a password without a username, and the client sends it that way.

What follows: nothing for this decision.

Update, 28 November 2026: [#187](https://github.com/dvkam/mqtt/pull/187) merged this work on 26 November 2026.

## Drain active QoS 1 exchanges before disconnect

Decided on 26 November 2026 (UTC), for [#147](https://github.com/dvkam/mqtt/issues/147). The proposal was written on 25 November. On 26 November, in a working session, the owner asked for the reviewed work to be merged once review and CI passed. Status: in the pull request for `feat/verified-mqtt-session-updates`, not merged when this entry was written.

Question: what happens to publications that are still waiting for PUBACK when the caller disconnects?

| Option | Trade-off |
| --- | --- |
| Send DISCONNECT at once | Shutdown starts at once. An earlier publication can lose its broker outcome even if PUBACK is about to arrive. |
| Drain every queued and active publication | More work completes, but the client keeps sending after the caller asked to stop. |
| Drain active exchanges within a deadline (chosen, recommended) | Known broker outcomes are kept, and queued work is not sent. The connection can stay open until the drain deadline. |

Reason given: a PUBACK that is already on its way should settle its publication, and a caller who asked to stop should not see new sends.

Consequences: `disconnect()` takes `drain`, `drainTimeoutMs` and `reasonCode`. A publication that the drain gives up on rejects with `ERR_MQTT_TIMEOUT`, and its outcome is unknown. `drain: false` keeps the immediate DISCONNECT. [Disconnect options and outcomes](qos1-publish.md#disconnect-with-active-publications)

What follows: inbound PUBLISH packets that arrive during the drain are dropped without a diagnostic, which #149 asks for.

Update, 28 November 2026: [#185](https://github.com/dvkam/mqtt/pull/185) merged this work on 26 November 2026.

## Derive the default WebSocket message limit from the packet limit

Decided on 26 November 2026 (UTC), for [#150](https://github.com/dvkam/mqtt/issues/150). The proposal was written on 25 November. On 26 November, in a working session, the owner asked for the reviewed work to be merged once review and CI passed. Status: in the pull request for `feat/verified-mqtt-session-updates`, not merged when this entry was written.

Question: how large may one WebSocket message be by default, and may a caller set it below the MQTT packet limit?

| Option | Trade-off |
| --- | --- |
| Default to twice the packet limit and allow a smaller explicit limit (chosen, recommended) | Two packets that are each valid fit in one message. A caller can still bound native message assembly below the packet size, because the decoder joins an MQTT packet split across messages. |
| Default to twice the packet limit and reject a smaller explicit limit, as #150 proposes | The configuration is simpler to explain, but a supported way to bound message assembly is lost. |

Reason given: a broker can split one MQTT packet across several WebSocket messages, and the tests cover that case. Rejecting the smaller limit would remove a working configuration. [Independent limits](websocket-packet-input.md#independent-limits)

Consequences: this departs from the #150 acceptance item that asks to reject a message limit below the packet limit.

What follows: nothing for this decision.

Update, 28 November 2026: [#185](https://github.com/dvkam/mqtt/pull/185) merged this work on 26 November 2026.

## Register a Will in CONNECT

Decided on 26 November 2026 (UTC), for [#161](https://github.com/dvkam/mqtt/issues/161). The proposal was written on 25 November. On 26 November, in a working session, the owner asked for the reviewed work to be merged once review and CI passed. Status: in the pull request for `feat/verified-mqtt-session-updates`, not merged when this entry was written.

Question: how does a caller register a Will Message?

| Option | Trade-off |
| --- | --- |
| A `will` option on every client factory, validated before the transport opens (chosen, recommended) | One shape for TCP, `ws`, the browser and custom transports. An invalid Will fails before any I/O. |
| A Will only on the TCP client | Less code, but WebSocket and browser users cannot register one. |

Reason given: #161 asks for a Will on the supported clients, validated with the publish topic rules before any I/O.

Consequences: the broker owns delivery of the Will, including Will QoS 2, while the client keeps its QoS 0 and 1 profile. A normal `disconnect()` discards the Will, and reason code 4 asks the broker to send it. An invalid Will rejects `connect()` with `ERR_MQTT_INVALID_ARGUMENT`, and the original error is the cause. [Will messages](will-message.md)

What follows: nothing for this decision.

Update, 28 November 2026: [#185](https://github.com/dvkam/mqtt/pull/185) merged this work on 26 November 2026.

## Return the connection and subscription acknowledgment results

Decided on 26 November 2026 (UTC), for [#152](https://github.com/dvkam/mqtt/issues/152). The proposal was written on 25 November. On 26 November, in a working session, the owner asked for the reviewed work to be merged once review and CI passed. Status: in the pull request for `feat/verified-mqtt-session-updates`, not merged when this entry was written.

Question: how does a caller read what the broker accepted in CONNACK, SUBACK and UNSUBACK?

| Option | Trade-off |
| --- | --- |
| A frozen `connection` snapshot on the session, and results from `subscribe()` and `unsubscribe()` (chosen, recommended) | Callers read the effective client identifier, broker capabilities and granted QoS without a callback. Code that typed these calls as `Promise<void>` needs an update. |
| Diagnostics events only | No return type changes, but every caller has to correlate events to calls. |

Reason given: #152 asks `subscribe()` to return the SUBACK result and the session to expose the CONNACK result.

Consequences: the snapshot fills in MQTT defaults for properties the broker left out. The subscription registry keeps ownership of each acknowledgment, and the result resolves only after the write settles. [Public types](public-types.md#broker-acknowledgment-results)

What follows: refused SUBACK, UNSUBACK and PUBACK errors still carry no Reason String or User Properties, as docs/errors.md lists.

Update, 28 November 2026: [#185](https://github.com/dvkam/mqtt/pull/185) merged this work on 26 November 2026.

## Errors carry stable codes

Decided on 26 November 2026 (UTC), for [#155](https://github.com/dvkam/mqtt/issues/155). The owner proposed the design in the "Proposed fix" section of #155 on 12 November. On 26 November, in a working session, the owner asked for the reviewed work to be merged once review and CI passed. Status: the first part is in the pull request for `feat/stable-error-codes`, not merged when this entry was written.

Question: how does a caller tell a retryable rejection from one that ended the session without matching message text?

| Option | Trade-off |
| --- | --- |
| One `MqttError` class with a closed string `code` and a `fatal` flag (chosen, recommended in #155) | One `instanceof` check. Codes that used to be numeric move to `reasonCode`, which breaks readers of `ProtocolInputError.code`. |
| Keep plain errors and document the messages | No break, but every caller keeps parsing English text. |

Reason given in #155: callers can only compare `error.message`, and a capacity rejection and a timeout look the same.

Consequences: `ProtocolInputError` extends `MqttError`, so its reason code moves from `code` to `reasonCode`. Capacity rejections are no longer `RangeError`. [docs/errors.md](errors.md) lists each code.

The implementation departs from the #155 proposal in the places below. They were not put to the owner as separate questions:

- `fatal` defaults by code. Only `ERR_MQTT_CAPACITY`, `ERR_MQTT_INVALID_ARGUMENT` and a refused SUBACK, UNSUBACK or PUBACK are non-fatal.
- `ERR_MQTT_WRITE_BUDGET` is not in the union yet, and the `WeakMap` in `src/nativeWriteBudget.ts` stays. A refusal leaves the session usable for a publication and ends it for a control packet, so the code alone would not say whether the session ended.
- Option validation still throws `RangeError`. The choice is between a Node-style `RangeError` that also has a `code` and an `MqttError` that drops `instanceof RangeError`.
- When an `onMessage` or `onQosOneMessage` handler rethrows a non-fatal rejection, the session ends with a fatal copy that keeps the code and sets `cause` to the original.
- A refused SUBACK, UNSUBACK or PUBACK carries `reasonCode` only. #155 also asks for `reasonString` and `userProperties`, which only DISCONNECT and CONNACK carry so far.
- `ProtocolInputError` stays a subclass of `MqttError`, exported from `mqtt/portable`, instead of becoming an alias. A caller's `instanceof ProtocolInputError` check keeps working.

What follows: the errors listed in [docs/errors.md](errors.md#gaps). One #155 acceptance item is also open. Some tests still assert only the message of a rejection that now has a code, and no check fails when `src/` adds an uncoded error.

Update, 28 November 2026: [#183](https://github.com/dvkam/mqtt/pull/183) merged the first part on 26 November 2026. The gaps and the open #155 acceptance item listed above remain.

## Browser client takes on the Node inbound rules

Decided on 16 November 2026 (UTC), for [#171](https://github.com/dvkam/mqtt/issues/171). Status: step 4 of the #171 plan, not merged when this entry was written.

Question: once one framer and one transport core serve both platforms, does the browser client take on the Node inbound rules?

| Option | Trade-off |
| --- | --- |
| Adopt the Node rules (chosen, recommended) | Four browser behaviors change. |
| Keep the browser behavior | No browser change, but a browser-only profile of the inbound rules stays behind a packet-level seam. The direction check, the QoS shaping and the close rules stay written twice. |

Reason given: the alternative leaves the direction check, the QoS shaping and the close rules duplicated.

The four browser changes, compared with 351f172:

- AUTH becomes a protocol error with reason code 0x82, and the client sends DISCONNECT. At 351f172 the browser decoder rejects AUTH with a plain error and ends the session without a DISCONNECT.
- A QoS 1 PUBLISH that arrives without a QoS 1 handler is dropped. At 351f172 the browser throws `Unsupported incoming MQTT QoS 1`, which ends the session.
- A fixed header with invalid flags fails on its first byte, as the Node framer does. At 351f172 the browser decoder checks the header only after the packet is complete.
- A close that misses its deadline escalates to a forced close. At 351f172 the browser's close rejects with `MQTT WebSocket close timed out`.

What follows: step 4 lists each change in its pull request and pins it with a test.

Update, 18 November 2026: step 4 moved the browser client onto the core. A browser cannot force a WebSocket closed, so the fourth change above takes this form: a close that misses its deadline stops waiting and resolves. Besides the four changes above, the browser now treats a QoS 0 PUBLISH with DUP set as protocol error 0x81, drops a QoS 2 PUBLISH without a QoS 1 handler, and ignores PUBREC, PUBREL and PUBCOMP, as the Node clients do. The packet-limit error is a RangeError, an invalid packet limit names its range, an abort with a non-Error reason reads `WebSocket connection aborted`, and the timeout is validated before the packet limit. The browser also rejects a client-only packet on its first byte with 0x82 and DISCONNECT, a pre-aborted signal wins over invalid options, a non-canonical Remaining Length names the Remaining Length, and a forced close drops the close listener at once. Each change case in `test/browser-core-changes.test.ts` fails against the browser client before the move, and each case in its kept block passes against it.

## `ws` moves to its own entry, `mqtt/ws`

Decided on 16 November 2026 (UTC), for [#171](https://github.com/dvkam/mqtt/issues/171). Status: step 3 of the #171 plan, not merged when this entry was written.

Question: where does the `ws` dependency go, so that TCP-only and browser applications neither install nor load it?

| Option | Trade-off |
| --- | --- |
| Optional peer, lazy import (recommended) | `createWebSocketClient` stays in the root entry and loads `ws` with a dynamic import when it connects. Without `ws` installed, the factory's `connect()` rejects with an install instruction. No import path changes. |
| Own entry `mqtt/ws` (chosen) | `createWebSocketClient` moves to a new `mqtt/ws` entry, with `ws` as an optional peer dependency. Callers change one import path. |
| Keep `ws` as a dependency | No change for users, but every install pulls `ws`. |

Reason given: the clearest separation.

Consequences, added by the author of this file:

- The root entry no longer refers to `ws` at all. With the lazy import it would still contain `import('ws')`, which a bundler tries to resolve. `mqtt/browser` has no reference to `ws` under any of the options.
- Node WebSocket users change one import path and install `ws` themselves, because an optional peer is not installed automatically.
- If `ws` is missing, importing `mqtt/ws` fails with Node's module-not-found error, unless step 3 adds a clearer message. The lazy import would have failed later, at `connect()`, with an install instruction.

What follows: step 3 adds the entry and a packed check that a TCP-only consumer never loads `ws`. Changes to `package.json` exports also fall under [#5](https://github.com/dvkam/mqtt/issues/5).

Update, 16 November 2026: step 3 added `mqtt/ws` and made `ws` an optional peer dependency with the range `^8.22.1`, the tested version. The package has no runtime dependency left. A packed check installs the tarball without `ws` and confirms that every other entry loads and that `mqtt/ws` fails with the module-not-found error naming `ws`. No clearer message was added.

Update, 26 November 2026: the dependency update raises the optional peer minimum to `8.23.0`. [ws 8.23.0](https://github.com/websockets/ws/releases/tag/8.23.0) fixes a remote memory exhaustion denial of service: a peer that floods Ping frames while reads are paused makes ws buffer Pong replies until the process runs out of memory.

## One byte-level transport replaces the packet-level seams

Decided on 16 November 2026 (UTC), for [#171](https://github.com/dvkam/mqtt/issues/171). Status: step 5 of the #171 plan, not merged when this entry was written.

Question: the new byte-level transport makes the experimental packet-level seams redundant. Removing them is breaking. Remove them or keep them?

| Option | Trade-off |
| --- | --- |
| Remove them (chosen, recommended) | One way to plug in a transport. `PacketTransport` and `connectPortable` (`mqtt/portable`), `openBrowserTransport` (`mqtt/browser`) and `openMqttWebSocket` (`mqtt/websocket`) go away, with a migration table in [public-types.md](public-types.md). |
| Keep them, deprecated, for one more release | More code to maintain, and the old seams still do their own framing. |

Reason given: it avoids two parallel custom-transport APIs.

Consequences, added by the author of this file:

- Only the byte-level transport shares the framer and the inbound rules, so a packet-level seam would need its own docs, tests and fixes.
- The evidence in #171 counts 630 lines across the three adapters: 173 for TCP, 174 for `ws` and 283 for the browser. In each, 17 to 19 lines repeat the same calls. What differs is how each opens, writes to, measures and closes its socket.
- #171 cites MQTT.js issue 2038, which asks for a transport interface that takes `Uint8Array` and `Buffer` without wrapping and keeps reading and writing on separate objects. A Node `Duplex` adapts to the contract in about 14 lines.

What follows: the contract is in the [#171 plan comment](https://github.com/dvkam/mqtt/issues/171#issuecomment-6912613511), and its public documentation moves to [public-types.md](public-types.md) in step 5. The core calls an opener once per connection attempt, so a reconnect supervisor can call it again later. The core creates the read side before it calls the opener. The opener returns a write-only object. After the removal, `mqtt/websocket` exports only the `WebSocketOptions` type, and `mqtt/portable` keeps `ProtocolInputError` and the packet types. `mqtt/websocket` is the native WebSocket opener and is unrelated to the new `mqtt/ws` entry for the Node `ws` client.

Update, 18 November 2026: the owner chose to remove `openBrowserTransport` and its types from `mqtt/browser` in step 4, when the browser client moves onto the core, instead of with the other seams in step 5. The recommended option was to keep it until step 5, so that each pull request has one kind of break. Step 5 still removes `PacketTransport`, `connectPortable` and `openMqttWebSocket`, and its migration table covers all removed seams.

Update, 24 November 2026: step 5 exposes `createTransportClient` through `mqtt` and `mqtt/portable`. The package documents a Node `Duplex` adapter. The WebSocket message limit stays with its adapters. The [migration table](public-types.md#migrate-removed-transport-hooks) lists a replacement for each removed export.

## The legacy `connect()` client is deleted

Decided on 15 November 2026 at 21:02 UTC, for [#164](https://github.com/dvkam/mqtt/issues/164) and [#159](https://github.com/dvkam/mqtt/issues/159). Status: done in [#170](https://github.com/dvkam/mqtt/pull/170). The #170 body and the closing comment on #164 date the decision 16 November. Why the dates differ is not recorded. #170 was opened at 21:08 UTC on 15 November, after the answer.

Question: the legacy root `connect()` was the last code that imported mqtt-packet at runtime. It was the MQTT.js-style `MqttClient` (275 lines) and the modules only it used, about 860 lines in 16 files. What happens to it?

| Option | Trade-off |
| --- | --- |
| Delete it (chosen, recommended) | The root `connect` export disappears, with `MqttClient`, its store, sequencer and option types. `createTcpClient`, `createWebSocketClient` and `createBrowserClient` remain. mqtt-packet becomes a development dependency that tests use as an independent reference. |
| Move it to `mqtt/legacy` | What #159 proposed. Bundles of the supported clients drop it, but mqtt-packet stays a runtime dependency for that entry. |
| Port it to the codec | No API removal and mqtt-packet becomes development-only, but it is the most work, spent on the path the supported clients replace. |

Reason given: `createTcpClient`, `createWebSocketClient` and `createBrowserClient` become the only ways to connect.

What follows: after #170 the package has one runtime dependency, `ws`, until step 3 of #171 makes it an optional peer. #170 also removed `pino` and `pino-pretty`, which no source file imported.
