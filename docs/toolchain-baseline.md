# Baseline for the Node 26 migration

## Fork at 45a11b8

The pinned fork is `45a11b838853cde82abfe33f52873ad74a599b0d`. The npm lockfile installed with lifecycle scripts disabled. The locked TypeScript build on WSL and Node 26.13.0 exited 1 with 17 diagnostics. They include missing packet and reason-code exports, incompatible sequencer calls, an undeclared allocator and an incomplete disconnect class. The legacy integration suite imports the build output.

An isolated AVA test called `t.fail()`. AVA ran the assertion and exited 1. The old coverage and logging pipeline exited 0 when c8 failed during startup. Bash reported pipeline component statuses `1 0`. The inherited AVA setup also allows zero-assertion tests, and `test_publish.js` and `test_timeout.js` contain focused tests.

## Released MQTT.js comparator

The comparator used `mqtt@5.16.1`, `vite@8.2.2` and Node 26.13.0 on WSL. The Node client connected over loopback TCP using MQTT 5. A scripted peer accepted CONNECT and acknowledged each QoS 1 PUBLISH. The workload sent 256-byte payloads with one publish outstanding, warmed up with 200 publishes and measured three rounds of 2,000. Latency measures the publish promise through PUBACK.

| Round | Publishes per second | p99 ms |
|---|---:|---:|
| 1 | 14,075.13 | 0.2480 |
| 2 | 16,933.38 | 0.1724 |
| 3 | 20,355.85 | 0.1087 |

The Vite browser entry exports a function that calls `mqtt.connect(url, { protocolVersion: 5 })`. With a default import, the minified ESM output measured 419,157 bytes and gzip measured 108,960 bytes. The released package's named `connect` import failed to bundle. Chromium 156.0.8078.4 loaded the built ESM and received a successful MQTT 5 CONNACK from the scripted WebSocket peer. Sustained-load comparisons still need independent tests.

To reproduce, run `npm ci` in [the isolated comparator directory](baseline/) and run `node measure.mjs` there with Node 26. Set `CHROMIUM_PATH` to a Chromium executable, or install Playwright's Chromium for the pinned driver. The fixture uses local ephemeral ports. [Raw results](baseline/results.jsonl)

For the same loopback fixture, use provisional budgets of at least 11,000 acknowledged publishes per second and p99 at most 0.4 ms on the same host. Require a smaller equivalent browser artifact in both byte measures. For the first sustained workload, start with a proposed library-owned queue cap of 4 MiB and 1,024 entries. Measure it under saturation before adopting it as a release default. The sequential loopback workload does not measure queue memory.

Refs #1.

## Toolchain verification

Run `pnpm install --frozen-lockfile` with Node 26.13.0 and pnpm 12.16.1. Run `pnpm test`, `pnpm test:types`, `pnpm lint`, and `pnpm format:check` separately from `pnpm build`.

Temporary Vitest probes for a wrong assertion, a test without assertions and a focused test each exited 1. Six topic-filter tests passed. The type fixtures cover packet narrowing, the 7.1 distributive constraint check and attributed ambient imports. A separate consumer compiles against emitted fixture declarations. The ambient declaration fixture stays outside the published package and is checked by TypeScript because the pinned Oxc parser does not parse that beta syntax yet.

The compiler keeps ES2020 output. The browser and consumer runtime matrix has yet to establish support for ES2026 features, so the library does not use them. A WSL source-build sample took 1.67 seconds and 71,592 KiB peak RSS, ending with diagnostics. It is a timing sample of the failing build. Editor integration and the supported consumer compiler range remain open.

The legacy AVA integration files still document intended behavior and remain outside the Vitest suite. The initial toolchain migration exposed the inherited client and sequencer errors. The repair adds Vitest regressions for the handshake and QoS 0 path. CI runs the source build as a separate step.

Refs #2.

## Workspace install policy

Use pnpm 12.16.1 from the package manifest. A regular or filtered `pnpm add` saves an exact version. A resolving command may deduplicate compatible versions across workspace importers, including importers outside its filter. Review the entire lockfile diff. Frozen installs keep the committed resolutions and fail when the manifest and lockfile disagree.

The workspace enforces a 1,440-minute release delay when registry metadata includes a publish date. In a controlled registry test, the built-in pnpm default accepted a young release as a fallback and wrote an exclusion. The explicit setting rejected the same release in a noninteractive install. The workspace has no release-age exceptions.

Strict peer checking rejects an incompatible peer. A separate probe with automatic peer installation disabled also rejected a missing peer. This workspace keeps automatic peer installation enabled.

With `autoDedupe` enabled, a filtered add of version 1.1.0 moved an unfiltered importer's compatible 1.0.0 resolution to 1.1.0. With the setting disabled, that importer stayed on 1.0.0. The subsequent frozen lockfile-only install left the lockfile unchanged. Enabling resolution metadata added four lockfile settings and preserved all package resolutions and integrity hashes.

The CI jobs use frozen installs. Run `pnpm dedupe --check` when reviewing dependency updates. The current single-package workspace has no separate CI job that resolves dependencies again.

Refs #51.
