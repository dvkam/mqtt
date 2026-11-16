# Design decisions

This file records decisions about the public API and the package layout. The repository owner, dvkam, made each choice. The questions were put to the owner in a working session outside GitHub, so this file is the first written record of the options and the trade-offs listed with them. In each table, "recommended" marks the option the question recommended. Three of the four choices followed that recommendation.

Each entry gives the question, the options, the choice, the stated reason, the consequences the author of this file adds, and what follows. Several entries describe steps of the [#171 plan](https://github.com/dvkam/mqtt/issues/171#issuecomment-6912613511) that had not been merged when the entry was written. The status line says which.

To add a decision, put a new entry at the top with the same parts. Do not rewrite old entries. When a follow-up lands, append a line "Update, <date>: ..." to the entry. An earlier decision about the repository itself is in [base-decision.md](base-decision.md).

Two terms used below:

- The inbound rules are what the client does with each packet the broker sends: which packet types it accepts, how it shapes QoS 0 and QoS 1 messages, how it handles AUTH, and how it closes. At 351f172 the Node clients apply them in `src/nodePacketListener.ts` and `src/nodePacketInput.ts`, and the browser client has its own in `src/browserClient.ts` and `src/browserTransport.ts`.
- A packet-level seam is a public hook for a custom transport that sends and receives decoded MQTT packets instead of bytes.

## Browser client takes on the Node inbound rules

Decided on 16 November 2026 (UTC), for [#171](https://github.com/dvkam/mqtt/issues/171). Status: step 4 of the #171 plan, not merged when this entry was written.

Question: once one framer and one transport core serve both platforms, does the browser client take on the Node inbound rules?

| Option | Trade-off |
| --- | --- |
| Adopt the Node rules (chosen, recommended) | Four browser behaviors change. |
| Keep the browser behavior | No browser change, but a browser-only profile of the inbound rules stays behind a packet-level seam. The direction check, the QoS shaping and the close rules stay written twice. |

Reason given: with one core, a second copy of the inbound rules would have to be kept in step with the first.

The four browser changes, compared with 351f172:

- AUTH becomes a protocol error with reason code 0x82, and the client sends DISCONNECT. At 351f172 the browser decoder rejects AUTH with a plain error and ends the session without a DISCONNECT.
- A QoS 1 PUBLISH that arrives without a QoS 1 handler is dropped. At 351f172 the browser throws `Unsupported incoming MQTT QoS 1`, which ends the session.
- A fixed header with invalid flags fails on its first byte, as the Node framer does. At 351f172 the browser decoder checks the header only after the packet is complete.
- A close that misses its deadline escalates to a forced close. At 351f172 the browser's close rejects with `MQTT WebSocket close timed out`.

What follows: step 4 lists each change in its pull request and pins it with a test.

## `ws` moves to its own entry, `mqtt/ws`

Decided on 16 November 2026 (UTC), for [#171](https://github.com/dvkam/mqtt/issues/171). Status: step 3 of the #171 plan, not merged when this entry was written.

Question: where does the `ws` dependency go, so that TCP-only and browser applications neither install nor load it?

| Option | Trade-off |
| --- | --- |
| Optional peer, lazy import (recommended) | `createWebSocketClient` stays in the root entry and loads `ws` with a dynamic import when it connects. Without `ws` installed, the factory's `connect()` rejects with an install instruction. No import path changes. The root entry still contains `import('ws')`, which a bundler tries to resolve. |
| Own entry `mqtt/ws` (chosen) | `createWebSocketClient` moves to a new `mqtt/ws` entry, with `ws` as an optional peer dependency. Callers change one import path. |
| Keep `ws` as a dependency | No change for users, but every install pulls `ws`. |

Reason given: the clearest separation.

Consequences, added by the author of this file:

- The root entry no longer refers to `ws` at all, so a bundle of the root entry has nothing to resolve. `mqtt/browser` has no reference to `ws` under any of the options.
- Node WebSocket users change one import path and install `ws` themselves, because an optional peer is not installed automatically.
- If `ws` is missing, importing `mqtt/ws` fails with Node's module-not-found error, unless step 3 adds a clearer message. The lazy import would have failed later, at `connect()`, with an install instruction.

What follows: step 3 adds the entry and a packed check that a TCP-only consumer never loads `ws`. Changes to `package.json` exports also fall under [#5](https://github.com/dvkam/mqtt/issues/5).

## One byte-level transport replaces the packet-level seams

Decided on 16 November 2026 (UTC), for [#171](https://github.com/dvkam/mqtt/issues/171). Status: step 5 of the #171 plan, not merged when this entry was written.

Question: the new byte-level transport makes the experimental packet-level seams redundant. Removing them is breaking. Remove them or keep them?

| Option | Trade-off |
| --- | --- |
| Remove them (chosen, recommended) | One way to plug in a transport. `PacketTransport` and `connectPortable` (`mqtt/portable`), `openBrowserTransport` (`mqtt/browser`) and `openMqttWebSocket` (`mqtt/websocket`) go away, with a migration table in [public-types.md](public-types.md). |
| Keep them, deprecated, for one more release | No break yet, but more code to maintain, and the old seams still do their own framing. |

Reason given: it avoids two parallel custom-transport APIs.

Consequences, added by the author of this file:

- Only the byte-level transport shares the framer and the inbound rules, so a packet-level seam would need its own docs, tests and fixes.
- The evidence in #171 counts 630 lines across the three adapters: 173 for TCP, 174 for `ws` and 283 for the browser. In each, 17 to 19 lines repeat the same calls. What differs is how each opens, writes to, measures and closes its socket.
- #171 cites MQTT.js issue 2038, which asks for a transport interface that takes `Uint8Array` and `Buffer` without wrapping and keeps reading and writing on separate objects. A Node `Duplex` adapts to the contract in about 15 lines.

What follows: the contract is in the [#171 plan comment](https://github.com/dvkam/mqtt/issues/171#issuecomment-6912613511), and its public documentation moves to [public-types.md](public-types.md) in step 5. The core calls an opener once per connection attempt, so a reconnect supervisor can call it again later. The core creates the read side before it calls the opener. The opener returns a write-only object. Removing `openMqttWebSocket` leaves `mqtt/websocket` empty, and `mqtt/portable` keeps `ProtocolInputError` and the packet types. Step 5 decides whether each entry stays. `mqtt/websocket` is the native WebSocket opener and is unrelated to the new `mqtt/ws` entry for the Node `ws` client.

## The legacy `connect()` client is deleted

Decided on 15 November 2026 at 21:02 UTC, for [#164](https://github.com/dvkam/mqtt/issues/164) and [#159](https://github.com/dvkam/mqtt/issues/159). Status: done in [#170](https://github.com/dvkam/mqtt/pull/170). The #170 body and the closing comment on #164 give 16 November, the date of the merge in the owner's time zone. The answer came before #170 was opened at 21:08 UTC.

Question: the legacy root `connect()` was the last code that imported mqtt-packet at runtime. It was the MQTT.js-style `MqttClient` (275 lines) and the modules only it used, about 860 lines in 16 files. What happens to it?

| Option | Trade-off |
| --- | --- |
| Delete it (chosen, recommended) | The root `connect` export disappears, with `MqttClient`, its store, sequencer and option types. `createTcpClient`, `createWebSocketClient` and `createBrowserClient` remain. mqtt-packet becomes a development dependency that tests use as an independent reference. |
| Move it to `mqtt/legacy` | What #159 proposed. Bundles of the supported clients drop it, but mqtt-packet stays a runtime dependency for that entry. |
| Port it to the codec | No API removal and mqtt-packet becomes development-only, but it is the most work, spent on the path the supported clients replace. |

Reason given: the supported clients replace it.

What follows: after #170 the package has one runtime dependency, `ws`, until step 3 of #171 makes it an optional peer. #170 also removed `pino` and `pino-pretty`, which no source file imported.
