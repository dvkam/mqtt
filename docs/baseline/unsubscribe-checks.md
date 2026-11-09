# Shared unsubscribe packed checks

The [packed-consumer job](https://github.com/dvkam/mqtt/actions/runs/42637560407/job/129229679277) checked GitHub's test merge `4643eae9fc7b89d7eeba897ce6e71b4f6f4aa50e`. It combines PR head `0e3842ce4e3318b77d69700117f415633e281930` with base `0dfef67ca85780a08d4f4fa7f2a6d2ad8d3b944e`. The production change is `6a83bed7d50f350bbe77c525d4c566858589f8fc`. The raw job log is retained locally in `work/unsubscribe-ci-packed.log`.

The runner used ubuntu-26.04 image `20261101.186.1`, Node 26.13.0 x64 and Mosquitto 2.0.22. The manifest pins pnpm 12.16.1, Vite 8.3.6, mqtt-packet 9.0.2 and ws 8.22.1. The clean consumer installs the packed tarball. The [workflow](../../.github/workflows/ci.yml) and the [fixture method](concurrent-subscriptions-checks.md) describe reproduction. Each broker fixture exercises unsubscribe after the timed echo. Timings measure the existing QoS 0 workloads.

## Echo observations

| UTC output time | Transport | Iterations | Echoes per second | p99 ms |
| --- | --- | --- | --- | --- |
| 14:44:32.2077627 | TCP | 100 | 13509.624932283006 | 0.15944999999999254 |
| 14:44:34.1585410 | Node WS | 5 | 3665.861154775603 | 0.492211999999995 |
| 14:44:34.5593677 | Node WSS with test CA | 5 | 3608.130995360646 | 0.46013300000004165 |
| 14:44:35.3062745 | Node WSS with client certificate | 5 | 3623.739844469198 | 0.4835689999999886 |
| 14:44:38.7690720 | Node WSS through CONNECT proxy | 1 | 1983.1747454593901 | 0.49482799999998406 |

These observations time the serial QoS 0 echo loop. The five- and one-sample p99 values equal their respective maxima. The cases have different iteration counts and transport setups. Use them as validation records. A controlled performance comparison requires a shared workload and repeat runs.

## Bundle observations

| UTC output time | Fixture | Emitted bytes | Gzip bytes |
| --- | --- | --- | --- |
| 14:44:32.8643629 | Portable packet-client trace | 16113 | 4655 |
| 14:44:32.9000504 | Stream comparison | 41189 | Unreported |
| 14:44:32.9000504 | Message queue module | 3091 | 1270 |
| 14:44:33.7032586 | WebSocket browser fixture (websocket-browser.mjs) | 36846 | 9645 |

Vite emits one ES library chunk per fixture. The byte counts describe these specific fixture imports. Gzip uses Node defaults. #18 owns comparable consumer workloads and performance budgets.
