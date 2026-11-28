# Verification models

Each `.tla` file here is a TLA+ module for one ownership or ordering rule of the client, in a small finite instance. `check.ts` runs every module with the TLC model checker. The [verification skill](../.agents/skills/verify-mqtt-lifecycle/SKILL.md) says when a change needs a look at a model.

## Run the models

    TLC_JAR=/path/to/tla2tools.jar node verification/check.ts

- Node from `.node-version` runs `check.ts` directly. The file imports only `node:` modules, so it needs no install.
- Java 11 or newer. Set `JAVA` when `java` is not on `PATH`.
- TLC 1.7.4, the `tla2tools.jar` of the [tlaplus v1.7.4 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4). The runner refuses any other file by its SHA-1.

The runner starts one single-worker TLC process per case and uses every core. `TLC_JOBS` sets another number of processes. Each process gets its own temporary directory, because TLC unpacks its standard modules into the Java temporary directory and two processes that share it fail to parse. The output keeps the order of the `models` table. Run the models and `pnpm test` one after the other.

The `models` job in `.github/workflows/ci.yml` runs the same command on every push and pull request.

## Positive models and expected faults

A row of the `models` table in `check.ts` names a module, a configuration file and, for an expected fault, an invariant.

- A positive model has no invariant in its row. Its configuration sets `Fault = "none"`. TLC must visit every reachable state without a violation, and the runner prints the number of distinct states.
- An expected fault is a configuration that removes one guard, for example `Fault = "budget"`. TLC must report that the named invariant is violated, and the runner prints `caught` with that invariant. An expected fault that passes means that no invariant depends on the guard.

## Header format

Each module starts with a comment that ties it to the source.

    \* Rule: What the invariants say about the client, in plain words.
    \* Source: src/portable.ts (exchange, abort)
    \* Tests: test/portable.test.ts, test/server-keep-alive.test.ts
    \* Mapping: Which function each action stands for.
    \* Not modeled: What the module leaves out.

A `Source:` line holds one path and, in parentheses, names that occur in that file. A module for code under `test/experiments/` says that the package does not export that code. `test/verification-headers.test.ts` fails when a header lacks a line, when a `Source:` or `Tests:` path does not exist, or when a name no longer occurs in its file. It cannot tell whether the mapping is still true. That comparison is the reviewer's work.

## Add a model

1. Write the module with a `Fault` constant, one configuration with `Fault = "none"` and one configuration for each guard that the rule depends on.
2. Add the rows to `models` in `check.ts`. Give each expected fault the invariant that it must violate.
3. Write the header from the functions you read, and name the tests that fail when a guard is removed from the source.
4. Run `check.ts` and `pnpm test test/verification-headers.test.ts`.

## Limits of every model

The models check safety in small finite instances. Callbacks run to completion. No model proves Error identity, timing, physical socket closure, memory use or MQTT conformance, and separate models do not prove their composition.

## Not modeled

No module covers these rules. Only tests check them.

- Session Present after Clean Start false. `SessionPresentAgreement` assumes Clean Start true. `receiveConnack` in `src/portable.ts` accepts Session Present true when `cleanStart` is false, and `open` then resumes the stored publications through `src/sessionState.ts`.
- The resend phase in `src/portable.ts` and `src/outboundQosOne.ts`: resends in stored order with DUP set, the QoS 0 and QoS 1 publications that wait for them, and no write after DISCONNECT. `QosOneOutbound` leaves out `resume` and `release`.
- The reconnect loop in `src/reconnect.ts`: the retry timer and `retryNow()`, the attempt count, the subscriptions made again after CONNACK, and `disconnect()` during an attempt or a wait.
- The page lifecycle adapter in `src/pageLifecycle.ts`.
