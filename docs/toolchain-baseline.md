# Baseline for the Node 26 migration

## Fork at 45a11b8

The pinned fork is `45a11b838853cde82abfe33f52873ad74a599b0d`. The npm lockfile installed with lifecycle scripts disabled. The locked TypeScript build on WSL and Node 26.13.0 exited 1 with 17 diagnostics. They include missing packet and reason-code exports, incompatible sequencer calls, an undeclared allocator and an incomplete disconnect class. The legacy integration suite imports the build output.

An isolated AVA test called `t.fail()`. AVA ran the assertion and exited 1. The old coverage and logging pipeline exited 0 when c8 failed during startup. Bash reported pipeline component statuses `1 0`. The inherited AVA setup also allows zero-assertion tests, and `test_publish.js` and `test_timeout.js` contain focused tests.

## Released MQTT.js comparator

The comparator used `mqtt@5.16.1`, `vite@8.2.2` and Node 26.13.0 on WSL. The Node client connected over loopback TCP using MQTT 5. A scripted peer accepted CONNECT and acknowledged each QoS 1 PUBLISH. The workload sent 256-byte payloads with one publish outstanding, warmed up with 200 publishes and measured three rounds of 2,000. Latency measures the publish promise through PUBACK.

| Round | Publishes per second | p99 ms |
|---|---:|---:|
| 1 | 11,612.63 | 0.3582 |
| 2 | 17,768.91 | 0.1364 |
| 3 | 19,695.03 | 0.1166 |

The Vite browser entry exports a function that calls `mqtt.connect(url, { protocolVersion: 5 })`. With a default import, the minified ESM output measured 419,157 bytes and gzip measured 108,960 bytes. The released package's named `connect` import failed to bundle. These results cover a browser build and a TCP wire smoke test. Browser broker behavior and sustained-load comparisons still need independent tests.

For the same loopback fixture, use provisional budgets of at least 11,000 acknowledged publishes per second and p99 at most 0.4 ms on the same host. Require a smaller equivalent browser artifact in both byte measures. For the first sustained workload, start with a proposed library-owned queue cap of 4 MiB and 1,024 entries. Measure it under saturation before adopting it as a release default. The sequential loopback workload does not measure queue memory.

Refs #1.
