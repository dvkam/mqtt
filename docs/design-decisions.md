# Design decisions

This file records decisions that change the public API or the package layout. Each entry gives the question, the options that were on the table, the choice and the reason for it, and what follows from it. The owner made each choice. The options and trade-offs are the ones written down when the question was asked. Newer entries come first.

## Browser client takes on the Node inbound rules

Decided on 16 November 2026, for [#171](https://github.com/dvkam/mqtt/issues/171).

Question: once one framer and one transport core serve both platforms, does the browser client take on the rules the Node clients apply to inbound packets?

| Option | Trade-off |
| --- | --- |
| Adopt the Node rules (chosen) | Four browser behaviors change, each listed and pinned by a test in the PR that makes the change. |
| Keep the browser behavior | No browser change, but a browser-only inbound profile stays behind a seam. The direction check, the QoS shaping and the close rules stay written twice. |

Reason: one set of inbound rules for every transport, with no second copy to keep in step. The browser changes in PR 4 of #171:

- An AUTH packet becomes a protocol error with reason code 0x82, and the client sends DISCONNECT. Today the browser ends the session without a DISCONNECT.
- A QoS 1 PUBLISH that arrives without a QoS 1 handler is dropped instead of throwing.
- A bad fixed header fails on its first byte.
- A close that misses its deadline escalates to a forced close instead of rejecting.

## `ws` moves to its own entry, `mqtt/ws`

Decided on 16 November 2026, for [#171](https://github.com/dvkam/mqtt/issues/171).

Question: where does the `ws` dependency go, so that TCP-only and browser applications neither install nor load it?

| Option | Trade-off |
| --- | --- |
| Optional peer, lazy import (recommended at the time) | `createWebSocketClient` stays in the root entry and loads `ws` with a dynamic import when it connects. Without `ws` installed, `connect()` rejects with an install instruction. No import path changes. |
| Own entry `mqtt/ws` (chosen) | `createWebSocketClient` moves to a new `mqtt/ws` entry, with `ws` as an optional peer dependency. Callers change one import path. |
| Keep `ws` as a dependency | No change for users, but every install pulls `ws`. |

Reason: the clearest separation. The import path names the dependency, so an application that imports only the root entry or `mqtt/browser` has no reference to `ws` at all. With the lazy import, the root entry would still name `ws`, and a missing `ws` would surface only when an application connects. The cost is a breaking change of one import path for Node WebSocket users.

What follows: PR 3 of #171 adds the entry and a packed check that a TCP-only consumer never loads `ws`. `createWebSocketClient` leaves the root entry.

## One byte-level transport replaces the packet-level seams

Decided on 16 November 2026, for [#171](https://github.com/dvkam/mqtt/issues/171).

Question: the new byte-level transport makes the experimental packet-level seams redundant. Removing them is breaking. Remove them or keep them?

| Option | Trade-off |
| --- | --- |
| Remove them (chosen) | One way to plug in a transport. `PacketTransport` and `connectPortable` (`mqtt/portable`), `openBrowserTransport` (`mqtt/browser`) and `openMqttWebSocket` (`mqtt/websocket`) go away, with a migration table in [public-types.md](public-types.md). |
| Keep them, deprecated, for one more release | No break yet, but two custom-transport APIs exist side by side, and the old ones keep their own framing code. |

Reason: two parallel custom-transport APIs would each need docs, tests and fixes, and only the byte-level one shares the framer and the inbound rules. The review behind #171 found that the three adapters each repeat option handling, abort wiring, write budgets and close handling, about 500 lines that differ mostly in socket calls. MQTT.js users asked for the byte-level shape: hand over a duplex and get a client. The first MQTT.js client took a function that returned a stream for the same reason, since a reconnect needs a fresh connection.

What follows: PR 5 of #171 removes the seams and adds the migration table. The contract itself is in #171. The core calls an opener once per connection attempt, so a reconnect supervisor can call it again. The core creates the read side before it calls the opener, so no byte arrives before the core listens. The opener returns a write-only object.

## The legacy `connect()` client is deleted

Decided on 15 November 2026, for [#164](https://github.com/dvkam/mqtt/issues/164) and [#159](https://github.com/dvkam/mqtt/issues/159). Done in [#170](https://github.com/dvkam/mqtt/pull/170).

Question: the legacy root `connect()`, the MQTT.js-style `MqttClient` of about 575 lines, was the last code that imported mqtt-packet at runtime. What happens to it?

| Option | Trade-off |
| --- | --- |
| Delete it (chosen) | The root `connect` export disappears, with `MqttClient`, its store, sequencer and option types. `createTcpClient`, `createWebSocketClient` and `createBrowserClient` remain. mqtt-packet becomes a development dependency that tests use as an independent reference. |
| Move it to `mqtt/legacy` | What #159 proposed. Bundles of the supported clients drop it, but mqtt-packet stays a runtime dependency for that entry. |
| Port it to the codec | No API removal, but the most work, spent on a client the supported clients replace. |

Reason: the supported clients replace it. Keeping it in any form meant either mqtt-packet at runtime or a second client to maintain.

What follows: the package has one runtime dependency, `ws`. #170 also removed `pino`, which no source file imported.
