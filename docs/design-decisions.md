# Design decisions

This file records decisions about the public API and the package layout. The repository owner, dvkam, made each choice or accepted it by asking for the reviewed work to be merged, as the entry says. Unless an entry says otherwise, the questions were put to the owner in a working session outside GitHub, so this file is the first written record of the options and the trade-offs listed with them. In each table, "recommended" marks the option the question recommended. Nine of the ten choices with a recommendation followed it. The four entries for #147, #150, #161 and #152 were decided together. The three entries of 16 November were answered together, so their order among themselves means nothing.

Each entry gives the question, the options, the choice, the stated reason, any consequences the author of this file adds, and what follows. Several entries describe steps of the [#171 plan](https://github.com/dvkam/mqtt/issues/171#issuecomment-6912613511) that had not been merged when the entry was written. The status line says which.

To add a decision, put a new entry at the top with the same parts. Do not rewrite old entries. When a follow-up lands, append a line "Update, <date>: ..." to the entry. An earlier decision about the repository itself is in [base-decision.md](base-decision.md).

Two terms used below:

- The inbound rules are what the client does with each packet the broker sends: which packet types it accepts, how it shapes QoS 0 and QoS 1 messages, how it handles AUTH, and how it closes. At 351f172 the Node clients apply them in `src/nodePacketListener.ts` and `src/nodePacketInput.ts`, and the browser client has its own in `src/browserClient.ts` and `src/browserTransport.ts`.
- A packet-level seam is a public hook for a custom transport that sends and receives decoded MQTT packets instead of bytes.

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
