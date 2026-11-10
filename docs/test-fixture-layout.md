# Test fixture layout

The library and sample use TypeScript. Node runs the codec benchmarks and the packed browser, WebSocket, Mosquitto session, TLS gateway and proxy launchers from TypeScript sources. The launchers start from the checkout and exercise an installed tarball.

| Retained JavaScript | Purpose |
| --- | --- |
| `test/packed/broker.mjs`, `browser.mjs`, `websocket-browser.mjs`, `websocket-session.mjs` | Installed ESM consumers. Their public imports resolve from the clean consumer. The checkout type-checks them with checkJs. |
| `test/packed/browser-build.mjs`, `websocket-check.mjs` | One-line entry points for the paths in GitHub Actions. Each imports its TypeScript launcher. They are checked with checkJs. |
| `oxlint.config.mjs`, `oxfmt.config.mjs` | Flat tool configuration loaded directly by the tools. |
| `docs/baseline/browser.mjs`, `measure.mjs` | Historical baseline runners for the pinned upstream comparison. |

The binding audit uses the compiler AST for declarations, callback parameters, destructuring, catch bindings and type parameters. It checks single-letter names and a list of common ambiguous abbreviations. Protocol terms and upstream property names stay readable in context. The audit is evidence for those checks. It does not certify every name choice.

## Codec benchmark entry

Run `node test/bench/codec.ts` after building. The migration check compared the JavaScript and TypeScript entries in WSL2 on Node 26.13.0. Both used the same 256-byte PUBLISH, 1,000 warmup calls and 10,000 measured calls. A single profiled run per entry checks the workload and checksums. Timing variation here is not a performance comparison.

| Entry | Workload | Elapsed ms | Sampled bytes | Checksum |
| --- | --- | ---: | ---: | ---: |
| before | prototype encode | 120.354 | 34594216 | 2730000 |
| before | mqtt-packet encode | 69.449 | 23632824 | 2730000 |
| before | prototype decode | 88.859 | 25644088 | 2560000 |
| before | mqtt-packet decode | 160.960 | 51122696 | 2560000 |
| after | prototype encode | 115.407 | 34534928 | 2730000 |
| after | mqtt-packet encode | 72.177 | 23870848 | 2730000 |
| after | prototype decode | 90.943 | 25548848 | 2560000 |
| after | mqtt-packet decode | 203.001 | 51291112 | 2560000 |

## Packed WebSocket fixture check

The installed tarball passed the stalled-peer check in WSL2 on Node 26.13.0 and Chromium 158.0.8127.18. Each adapter used a 131,072-byte send budget. The next send would have exceeded the limit in each case.

| Adapter | Sends admitted | Peak queued bytes | Close ms |
| --- | ---: | ---: | ---: |
| ws | 39 | 65550 | 498.410 |
| Node WebSocket | 2 | 131072 | 498.642 |
| Chromium WebSocket | 2 | 131072 | 500.500 |

The Vite browser fixture measured 42,294 bytes and 10,778 bytes with gzip. These are smoke-check observations from one run. Native buffering and event scheduling affect the send counts and close times.

## Packed launcher migration

The before and after host launchers used the same installed tarball in WSL2 with Node 26.13.0 and Chromium 158.0.8127.18. The compiler checks, installed TCP and WebSocket probes, and Chromium receive and cancellation checks passed. The workflow paths load the TypeScript launchers through their existing JavaScript entry points.

| Bundled fixture | Before bytes | After bytes | Before gzip | After gzip |
| --- | ---: | ---: | ---: | ---: |
| Portable browser trace | 20983 | 20983 | 5744 | 5744 |
| Isolated queue | 3114 | 3114 | 1277 | 1277 |
| Browser WebSocket probe | 43725 | 43725 | 11238 | 11238 |

The full stream fixture measured 48,114 bytes on both runs. The WebSocket pressure check after migration recorded peak queued bytes of 65,550 for ws and 131,072 for Node and Chromium native WebSocket. All three used a 131,072-byte budget. These are smoke-check observations. The local transcripts retain the individual timings.
