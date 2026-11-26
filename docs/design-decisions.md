# Design decisions

This file records decisions about the public API and the package layout. The repository owner, dvkam, made each choice. The questions were put to the owner in a working session outside GitHub, so this file is the first written record of the options and the trade-offs listed with them. In each table, "recommended" marks the option the question recommended. Four of the five choices followed that recommendation. The three entries of 16 November were answered together, so their order among themselves means nothing.

Each entry gives the question, the options, the choice, the stated reason, any consequences the author of this file adds, and what follows. Several entries describe steps of the [#171 plan](https://github.com/dvkam/mqtt/issues/171#issuecomment-6912613511) that had not been merged when the entry was written. The status line says which.

To add a decision, put a new entry at the top with the same parts. Do not rewrite old entries. When a follow-up lands, append a line "Update, <date>: ..." to the entry. An earlier decision about the repository itself is in [base-decision.md](base-decision.md).

Two terms used below:

- The inbound rules are what the client does with each packet the broker sends: which packet types it accepts, how it shapes QoS 0 and QoS 1 messages, how it handles AUTH, and how it closes. At 351f172 the Node clients apply them in `src/nodePacketListener.ts` and `src/nodePacketInput.ts`, and the browser client has its own in `src/browserClient.ts` and `src/browserTransport.ts`.
- A packet-level seam is a public hook for a custom transport that sends and receives decoded MQTT packets instead of bytes.

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
