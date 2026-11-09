# Parser acknowledgment packed checks

The [packed-consumer job](https://github.com/dvkam/mqtt/actions/runs/42689030812/job/129403525022) checked GitHub's test merge `d4b341e3c86de31d578c3487adb7006bcb26a6c6`. It combines PR head `841020429ef6287cb343f35e167f77a526a768da` with base `e040e76c21d0b4294a34c974bfa5d3904be80f87`. The production change is `7f63867536437ca115413c42a8e92aba7350cffd`. The raw job log is retained locally in `work/parser-ack-ci-packed.log`.

The runner used ubuntu-26.04 image `20261101.186.1`, Node 26.13.0 x64 and Mosquitto 2.0.22. The manifest pins pnpm 12.16.1, Vite 8.3.6, mqtt-packet 9.0.2 and ws 8.22.1. The clean consumer installs the packed tarball. The [workflow](../../.github/workflows/ci.yml) and the [fixture method](concurrent-subscriptions-checks.md) describe reproduction. The fixed wire regressions exercise rejected acknowledgments. The broker and bundle observations use the existing valid workloads.

## Echo observations

| UTC output time | Transport | Iterations | Echoes per second | p99 ms |
| --- | --- | --- | --- | --- |
| 20:02:28.4485782 | TCP | 100 | 2032.4653825414882 | 0.3220580000000126 |
| 20:02:30.3715801 | Node WS | 5 | 5141.330020945793 | 0.311600999999996 |
| 20:02:30.7676556 | Node WSS with test CA | 5 | 4869.815229470664 | 0.3090180000000373 |
| 20:02:31.5003344 | Node WSS with client certificate | 5 | 3996.3138001507796 | 0.4136450000000309 |
| 20:02:34.9180023 | Node WSS through CONNECT proxy | 1 | 2661.8540345722063 | 0.36705599999999095 |

These observations time the serial QoS 0 echo loop. The five- and one-sample p99 values equal their respective maxima. The cases have different iteration counts and transport setups. Use them as validation records. A controlled performance comparison requires a shared workload and repeat runs.

## Bundle observations

| UTC output time | Fixture | Emitted bytes | Gzip bytes |
| --- | --- | --- | --- |
| 20:02:29.0896267 | Portable packet-client trace | 19715 | 5428 |
| 20:02:29.1304446 | Stream comparison | 46372 | Unreported |
| 20:02:29.1304446 | Message queue module | 3091 | 1270 |
| 20:02:29.8796705 | WebSocket browser fixture (websocket-browser.mjs) | 42029 | 10774 |

Vite emits one ES library chunk per fixture. The byte counts describe these specific fixture imports. Gzip uses Node defaults. #18 owns comparable consumer workloads and performance budgets.
