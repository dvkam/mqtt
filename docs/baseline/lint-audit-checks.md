# Lint cleanup packed checks

The [packed-consumer job](https://github.com/dvkam/mqtt/actions/runs/42707133490/job/129466775956) checked GitHub's test merge `0dfcef9512f50b3b6e9f9d4d1d67eaf8f27582ae`. It combines PR head `7f63fd525b52109b550268f383a1d71f1633b595` with base `77f721ac109fd77ecfe6e1a44e5c54c275af6247`. The production change is `7f63fd525b52109b550268f383a1d71f1633b595`. The raw job log is retained locally in `work/lint-audit-ci-packed.log`.

The runner used ubuntu-26.04 image `20261101.186.1`, Node 26.13.0 x64 and Mosquitto 2.0.22. The manifest pins pnpm 12.16.1, Vite 8.3.6, mqtt-packet 9.0.2 and ws 8.22.1. The clean consumer installs the packed tarball. The [workflow](../../.github/workflows/ci.yml) and the [fixture method](concurrent-subscriptions-checks.md) describe reproduction. The emitted declarations and existing broker fixtures exercise the unchanged public contracts after the lint cleanup.

## Echo observations

| UTC output time | Transport | Iterations | Echoes per second | p99 ms |
| --- | --- | --- | --- | --- |
| 21:56:23.1893451 | TCP | 100 | 2104.327463150542 | 0.2306859999999915 |
| 21:56:25.0608709 | Node WS | 5 | 5497.314561836511 | 0.2797999999999945 |
| 21:56:25.4521870 | Node WSS with test CA | 5 | 5158.814091816771 | 0.28786200000001827 |
| 21:56:26.1782402 | Node WSS with client certificate | 5 | 4359.992361293571 | 0.32645000000002256 |
| 21:56:29.6049836 | Node WSS through CONNECT proxy | 1 | 2758.438062031697 | 0.3524590000000103 |

These observations time the serial QoS 0 echo loop. The five- and one-sample p99 values equal their respective maxima. The cases have different iteration counts and transport setups. Use them as validation records. A controlled performance comparison requires a shared workload and repeat runs.

## Bundle observations

| UTC output time | Fixture | Emitted bytes | Gzip bytes |
| --- | --- | --- | --- |
| 21:56:23.8747060 | Portable packet-client trace | 19704 | 5422 |
| 21:56:23.9053896 | Stream comparison | 46361 | Unreported |
| 21:56:23.9053896 | Message queue module | 3091 | 1270 |
| 21:56:24.6333553 | WebSocket browser fixture (websocket-browser.mjs) | 42018 | 10769 |

Vite emits one ES library chunk per fixture. The byte counts describe these specific fixture imports. Gzip uses Node defaults. #18 owns comparable consumer workloads and performance budgets.
