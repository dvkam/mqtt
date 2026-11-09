# Legacy comment audit packed checks

The [packed-consumer job](https://github.com/dvkam/mqtt/actions/runs/42705191383/job/129460025208) checked GitHub's test merge `111c4f49d42716fe2788ca2837e10d671a962e44`. It combines PR head `1bad78257f7f85007d350a2af44948a4d6550846` with base `963e0d809d2f989e2a58655b42ab26b2d482c1c7`. The production change is `a1f37b97b09ce9aa004ca0650033fd6780d345f8`. The raw job log is retained locally in `work/legacy-audit-ci-packed.log`.

The runner used ubuntu-26.04 image `20261101.186.1`, Node 26.13.0 x64 and Mosquitto 2.0.22. The manifest pins pnpm 12.16.1, Vite 8.3.6, mqtt-packet 9.0.2 and ws 8.22.1. The clean consumer installs the packed tarball. The [workflow](../../.github/workflows/ci.yml) and the [fixture method](concurrent-subscriptions-checks.md) describe reproduction. The legacy TLS regression uses an injected socket error. The packed observations use the existing valid broker and browser workloads.

## Echo observations

| UTC output time | Transport | Iterations | Echoes per second | p99 ms |
| --- | --- | --- | --- | --- |
| 21:43:55.1431248 | TCP | 100 | 1939.9606995001661 | 0.32881899999998154 |
| 21:43:57.2270583 | Node WS | 5 | 4523.56869762838 | 0.34408100000001696 |
| 21:43:57.6404240 | Node WSS with test CA | 5 | 3970.015268678783 | 0.3658940000000257 |
| 21:43:58.4204605 | Node WSS with client certificate | 5 | 3580.982120156202 | 0.38951900000000705 |
| 21:44:02.1005379 | Node WSS through CONNECT proxy | 1 | 2343.215453974609 | 0.4169299999999794 |

These observations time the serial QoS 0 echo loop. The five- and one-sample p99 values equal their respective maxima. The cases have different iteration counts and transport setups. Use them as validation records. A controlled performance comparison requires a shared workload and repeat runs.

## Bundle observations

| UTC output time | Fixture | Emitted bytes | Gzip bytes |
| --- | --- | --- | --- |
| 21:43:55.8870576 | Portable packet-client trace | 19715 | 5428 |
| 21:43:55.9250711 | Stream comparison | 46372 | Unreported |
| 21:43:55.9250711 | Message queue module | 3091 | 1270 |
| 21:43:56.8082944 | WebSocket browser fixture (websocket-browser.mjs) | 42029 | 10774 |

Vite emits one ES library chunk per fixture. The byte counts describe these specific fixture imports. Gzip uses Node defaults. #18 owns comparable consumer workloads and performance budgets.
