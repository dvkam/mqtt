# Outbound QoS 1 CI observations

The [packed-consumer job](https://github.com/dvkam/mqtt/actions/runs/42634764459/job/129219877590) checked GitHub's test merge `38a4f2435c1321e4717449b0369673b6d0287757`. It combines PR head `6574e376fb90b12ee81a023129ede9af525e949b` with base `fc190182262c6485e0ecf4ad73076cb91a3dfae8`. The production change is `0688dff85659085d9d5f4d4391f0a9218e523b51`. The raw job log is retained locally in `work/qos1-outbound-ci-packed.log`.

The runner used ubuntu-26.04 image `20261101.186.1`, Node 26.13.0 x64 and Mosquitto 2.0.22. The manifest pins pnpm 12.16.1, Vite 8.3.6, mqtt-packet 9.0.2 and ws 8.22.1. The clean consumer installs the packed tarball. The [workflow](../../.github/workflows/ci.yml) and the [fixture method](concurrent-subscriptions-checks.md) describe reproduction. Two QoS 1 publishes and their PUBACKs complete before the timed QoS 0 loop. The Node and browser client checks run from the installed artifact.

## Echo observations

| UTC output time | Transport | Iterations | Echoes per second | p99 ms |
| --- | --- | --- | --- | --- |
| 14:27:20.2219267 | TCP | 100 | 5313.129556041798 | 0.2934680000000185 |
| 14:27:23.2885328 | Node WS | 5 | 2265.9253767327546 | 0.7650759999999934 |
| 14:27:23.7395564 | Node WSS with test CA | 5 | 2278.962306419236 | 0.7071080000000052 |
| 14:27:24.6188910 | Node WSS with client certificate | 5 | 2079.197463046396 | 0.7723199999999792 |
| 14:27:29.2087536 | Node WSS through CONNECT proxy | 1 | 1339.148810233274 | 0.733237000000031 |

These observations time the serial QoS 0 echo loop. The five- and one-sample p99 values equal their respective maxima. The cases have different iteration counts and transport setups. Use them as validation records. A controlled performance comparison requires a shared workload and repeat runs.

## Bundle observations

| UTC output time | Fixture | Emitted bytes | Gzip bytes |
| --- | --- | --- | --- |
| 14:27:21.2452367 | Portable packet-client trace | 15588 | 4500 |
| 14:27:21.3016966 | Stream comparison | 39695 | Unreported |
| 14:27:21.3016966 | Message queue module | 3091 | 1270 |
| 14:27:22.5981543 | WebSocket browser fixture (websocket-browser.mjs) | 35352 | 9319 |

Vite emits one ES library chunk per fixture. The byte counts describe these specific fixture imports. Gzip uses Node defaults. #18 owns comparable consumer workloads and performance budgets.
