# Inbound QoS 1 packed checks

The [packed-consumer job](https://github.com/dvkam/mqtt/actions/runs/42641330706/job/129242907807) checked GitHub's test merge `641ddaaed856b62e0b2380c6232af138569df143`. It combines PR head `37d9cb27382118d4c630962d3d270d105c22ed3f` with base `a013a9b95b6886316ee18843ad88ddf105b57d49`. The production change is `04f3dff8e780f05098a1bd356d64f70251b33d5b`. The raw job log is retained locally in `work/qos1-inbound-ci-packed.log`.

The runner used ubuntu-26.04 image `20261101.186.1`, Node 26.13.0 x64 and Mosquitto 2.0.22. The manifest pins pnpm 12.16.1, Vite 8.3.6, mqtt-packet 9.0.2 and ws 8.22.1. The clean consumer installs the packed tarball. The [workflow](../../.github/workflows/ci.yml) and the [fixture method](concurrent-subscriptions-checks.md) describe reproduction. The fixtures verify inbound delivery before timing the existing QoS 0 echo workloads.

## Echo observations

| UTC output time | Transport | Iterations | Echoes per second | p99 ms |
| --- | --- | --- | --- | --- |
| 15:07:20.1919553 | TCP | 100 | 2051.4273133761176 | 0.272987999999998 |
| 15:07:22.2435347 | Node WS | 5 | 5498.2696945270945 | 0.29777500000000146 |
| 15:07:22.6533523 | Node WSS with test CA | 5 | 4233.044329286911 | 0.34792999999996255 |
| 15:07:23.3995246 | Node WSS with client certificate | 5 | 4821.233483659367 | 0.31243599999999105 |
| 15:07:26.9822355 | Node WSS through CONNECT proxy | 1 | 2645.397669404619 | 0.36749900000000935 |

These observations time the serial QoS 0 echo loop. The five- and one-sample p99 values equal their respective maxima. The cases have different iteration counts and transport setups. Use them as validation records. A controlled performance comparison requires a shared workload and repeat runs.

## Bundle observations

| UTC output time | Fixture | Emitted bytes | Gzip bytes |
| --- | --- | --- | --- |
| 15:07:20.8477433 | Portable packet-client trace | 18586 | 5174 |
| 15:07:20.8840207 | Stream comparison | 45149 | Unreported |
| 15:07:20.8840207 | Message queue module | 3091 | 1270 |
| 15:07:21.6718527 | WebSocket browser fixture (websocket-browser.mjs) | 40806 | 10457 |

Vite emits one ES library chunk per fixture. The byte counts describe these specific fixture imports. Gzip uses Node defaults. #18 owns comparable consumer workloads and performance budgets.

## Local installed check

The local tarball used the same source under Node 26.13.0, Mosquitto 2.0.18 and Chromium 158.0.8127.18 on Linux x64 in WSL2. TCP, Node WS, WSS, mutual TLS and WSS through the CONNECT proxy each ran the QoS 1 tracer and the separate QoS 0 echo. The installed browser adapter passed Chromium WS and WSS through the local TLS gateway. Native Node direct WSS to Mosquitto showed the existing experimental HTTP/2 failure. The native Node client passed through the gateway.

| Echo fixture | Iterations | Echoes per second | p99 ms |
| --- | ---: | ---: | ---: |
| TCP | 100 | 1442.286 | 0.507 |
| Node WS | 5 | 3071.170 | 0.470 |
| Node WSS | 5 | 2575.913 | 0.526 |
| Node mutual TLS | 5 | 2819.038 | 0.494 |
| Node WSS through proxy | 1 | 1516.080 | 0.648 |

The local portable browser fixture was 18,724 bytes and 5,180 gzip bytes. Its stream comparison fixture was 45,448 bytes. The queue module was 3,114 bytes and 1,274 gzip bytes.

| Chromium queue mode | Delivered | Elapsed ms | Messages per second | p99 delivery ms | Peak items | Peak bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Callback | 2000 | 8.2 | 243902.439 | 0 | 0 | 0 |
| Async iterator | 2000 | 15.2 | 131578.947 | 0.1 | 15 | 3870 |
| Web Stream | 2000 | 16.5 | 121212.121 | 1.7 | 16 | 4128 |

All three modes preserved order and checksum 1,999,000. These local rows are smoke observations from single runs.
