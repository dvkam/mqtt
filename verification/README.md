# Verification models

Each `.tla` file here is a TLA+ module for one ownership or ordering rule of the client, in a small finite instance. `check.ts` runs every module with the TLC model checker. The [verification skill](../.agents/skills/verify-mqtt-lifecycle/SKILL.md) says when a change needs a look at a model. To see what each model covers, run `grep -A2 'Rule:' verification/*.tla`.

## Run the models

    TLC_JAR=/path/to/tla2tools.jar node verification/check.ts

- Node from `.node-version` runs `check.ts` directly. The file imports only `node:` modules, so it needs no install.
- Java 11 or newer. Set `JAVA` when `java` is not on `PATH`.
- TLC 1.7.4, the `tla2tools.jar` of the [tlaplus v1.7.4 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). The runner refuses any other file by its SHA-1.

The runner starts one single-worker TLC process per case and uses every core. `TLC_JOBS` sets another number of processes. Each process gets its own temporary directory, because TLC unpacks its standard modules into the Java temporary directory and two processes that share it fail to parse. The output keeps the order of the `models` table. The runner refuses to start when a `.tla` or `.cfg` file here has no row in that table. Run the models and `pnpm test` one after the other.

The `models` job in `.github/workflows/ci.yml` runs the same command on every pull request, on every push to `main` and on the weekly schedule.

## Positive models and expected faults

A row of the `models` table in `check.ts` names a module, a configuration file and, for an expected fault, an invariant.

- A positive model has no invariant in its row. Its configuration removes no guard. Most modules write that as `Fault = "none"`. PingFence writes it as `UnsafeRetry = FALSE` and WebSocketOpen as `KeepOpenListener = FALSE`. TLC must visit every reachable state without a violation, and the runner prints the number of distinct states.
- An expected fault is a configuration that removes one guard, for example `Fault = "budget"` or `UnsafeRetry = TRUE`. TLC must report that the named invariant is violated, and the runner prints `caught` with that invariant. An expected fault that passes means that no invariant depends on the guard.

## Header format

Each module starts with a comment that ties it to the source.

    \* Rule: What the invariants say about the client, in plain words.
    \* Source: src/portable.ts (exchange, abort)
    \* Tests: test/portable.test.ts, test/server-keep-alive.test.ts
    \* Mapping: Which function each action stands for.
    \* Not modeled: What the module leaves out.

The header is the block of comment lines directly under the module line. A `Source:` line holds one path and, in parentheses, names that occur in that file. A module for code under `test/experiments/` says that the package does not export that code. `test/verification-headers.test.ts` fails when a header lacks a line, when a `Source:` or `Tests:` path is not a file, or when a name no longer occurs in its file. The name check looks for a whole word anywhere in the file, so a common name such as `push` or `fail` still passes after its function is gone. The test cannot tell whether the mapping is still true. That comparison is the reviewer's work.

## Add a model

1. Write the module with a `Fault` constant, one configuration with `Fault = "none"` and one expected fault for each guard that the rule depends on.
2. Add the rows to `models` in `check.ts`. Give each expected fault the invariant that it must violate.
3. Write the header from the functions you read, and name the tests that fail when a guard is removed from the source.
4. Run `check.ts` and `pnpm test test/verification-headers.test.ts`.

## Limits of every model

The models check safety in small finite instances. Callbacks run to completion. No model proves Error identity, timing, physical socket closure, memory use or MQTT conformance, and separate models do not prove their composition.

## Not modeled

No module covers these rules. Only tests check them.

- The highest QoS a client acknowledges. `acknowledgedQos` in `src/portable.ts` derives it from the handlers, the packet listener in the `PortableClient` constructor ends the session on a PUBLISH above it, and `captureSessionOptions` in `src/transportCore.ts` compares it with the granted QoS in the session state.
- A packet other than CONNACK before CONNACK, which `rejectBeforeConnack` in `src/portable.ts` ends the attempt for. `DuplicateConnack` and `ConnackAgreement` start at the CONNACK.
- Session Present after Clean Start false. `SessionPresentAgreement` assumes Clean Start true. When `cleanStart` is false, `receiveConnack` in `src/portable.ts` accepts Session Present true with reason code 0 only, and `open` then resumes the stored publications through `src/sessionState.ts`. A refused CONNACK with Session Present true stays a protocol error.
- The resend phase in `src/portable.ts` and `src/outboundQosOne.ts`: resends in stored order with DUP set, the QoS 0 and QoS 1 publications that wait for them, and no write after DISCONNECT. `QosOneOutbound` leaves out `resume` and `releaseQueued`. `QosTwoOutbound` covers which packet a resumed QoS 2 exchange continues with and that a stored PUBREL does not wait for the quota, not the order of the resends.
- The reconnect loop in `src/reconnect.ts`: the retry timer and `retryNow()`, the attempt count, the subscriptions made again after CONNACK, and `disconnect()` during an attempt or a wait.
- The page lifecycle adapter in `src/pageLifecycle.ts`.
- Maximum Packet Size: the CONNACK value below 4 that `receiveConnack` rejects, and the size checks in `PublicationAdmission.reserve` and `SubscriptionExchanges.reserve`.
- The Server Keep Alive schedule in `startKeepAlive` and `scheduleKeepAlive` in `src/portable.ts`. `PingFence` covers the ping exchange only.
- The encoder, `encodePacket` in `src/wireCodec.ts`. The codec models cover decoding only.
