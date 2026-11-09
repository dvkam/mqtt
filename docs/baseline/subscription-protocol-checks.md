# Subscription acknowledgment packed checks

The [packed-consumer job](https://github.com/dvkam/mqtt/actions/runs/42643559437/job/129250688827) checked GitHub's test merge `014ec613ac73f8feff3c52d82c8346e4535e11e7`. It combines PR head `881776026b4e1c3ff5a8b6b448564e5aebc4b41f` with base `39d57f1f8d7a82d1902f84fa729d1c35086977f5`. The production change is `a46c5c008b226712e5cd9614cf585c031169dac8`. The raw job log is retained locally in `work/subscription-protocol-ci-packed.log`.

The runner used ubuntu-26.04 image `20261101.186.1`, Node 26.13.0 x64 and Mosquitto 2.0.22. The manifest pins pnpm 12.16.1, Vite 8.3.6, mqtt-packet 9.0.2 and ws 8.22.1. The clean consumer installs the packed tarball. The [workflow](../../.github/workflows/ci.yml) and the [fixture method](concurrent-subscriptions-checks.md) describe reproduction. Fixed TCP and browser regressions exercise invalid acknowledgments. The broker and bundle observations use the existing valid workloads.

## Echo observations

| UTC output time | Transport | Iterations | Echoes per second | p99 ms |
| --- | --- | --- | --- | --- |
| 15:20:27.6278589 | TCP | 100 | 1716.4361341320007 | 0.45297800000000166 |
| 15:20:30.2740226 | Node WS | 5 | 3442.1488371389037 | 0.42814200000000824 |
| 15:20:30.7112867 | Node WSS with test CA | 5 | 3023.4553620074207 | 0.4574070000000461 |
| 15:20:31.5444902 | Node WSS with client certificate | 5 | 2978.2202751279915 | 0.4969110000000114 |
| 15:20:35.8879584 | Node WSS through CONNECT proxy | 1 | 1869.1169543860883 | 0.5194930000000113 |

These observations time the serial QoS 0 echo loop. The five- and one-sample p99 values equal their respective maxima. The cases have different iteration counts and transport setups. Use them as validation records. A controlled performance comparison requires a shared workload and repeat runs.

## Bundle observations

| UTC output time | Fixture | Emitted bytes | Gzip bytes |
| --- | --- | --- | --- |
| 15:20:28.5350725 | Portable packet-client trace | 19517 | 5379 |
| 15:20:28.5871663 | Stream comparison | 45782 | Unreported |
| 15:20:28.5871663 | Message queue module | 3091 | 1270 |
| 15:20:29.7309539 | WebSocket browser fixture (websocket-browser.mjs) | 41439 | 10620 |

Vite emits one ES library chunk per fixture. The byte counts describe these specific fixture imports. Gzip uses Node defaults. #18 owns comparable consumer workloads and performance budgets.
