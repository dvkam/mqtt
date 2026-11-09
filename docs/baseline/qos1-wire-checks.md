# QoS 1 wire CI observations

The [packed-consumer job](https://github.com/dvkam/mqtt/actions/runs/42630749067/job/129206090583) checked GitHub's test merge `2a74c70c74b60742d95e2dd924f407cdd9a349fd`. It combines PR head `73ece7217d7e4303ccec48740f0ee54a5013c8f1` with base `0a1cc24a16ed80809aa38b270530980bf657a7de`. The production change is `50de9449cfdf1359e831118bde926167edc23960`. The raw job log is retained locally in `work/qos1-wire-ci-packed.log`.

The runner used ubuntu-26.04 image `20261101.186.1`, Node 26.13.0 x64 and Mosquitto 2.0.22. The manifest pins pnpm 12.16.1, Vite 8.3.6, mqtt-packet 9.0.2 and ws 8.22.1. The clean consumer installs the packed tarball. The [workflow](../../.github/workflows/ci.yml) and the [fixture method](concurrent-subscriptions-checks.md) describe reproduction. The wire profile expands the codec while the public publish API continues to send QoS 0 in this run.

## Echo observations

| UTC output time | Transport | Iterations | Echoes per second | p99 ms |
| --- | --- | --- | --- | --- |
| 14:02:36.8967751 | TCP | 100 | 5983.525201052438 | 0.40505699999999933 |
| 14:02:39.6242170 | Node WS | 5 | 914.6289039562856 | 2.6558789999999988 |
| 14:02:40.0721581 | Node WSS with test CA | 5 | 1659.4805626701177 | 1.1116979999999899 |
| 14:02:40.9351794 | Node WSS with client certificate | 5 | 1002.885099855265 | 3.176807999999994 |
| 14:02:45.3291736 | Node WSS through CONNECT proxy | 1 | 802.2726780423483 | 1.2230750000000512 |

These observations time the serial QoS 0 echo loop. The five- and one-sample p99 values equal their respective maxima. The cases have different iteration counts and transport setups. Use them as validation records. A controlled performance comparison requires a shared workload and repeat runs.

## Bundle observations

| UTC output time | Fixture | Emitted bytes | Gzip bytes |
| --- | --- | --- | --- |
| 14:02:37.8378285 | Portable packet-client trace | 10208 | 3083 |
| 14:02:37.8977867 | Stream comparison | 34087 | Unreported |
| 14:02:37.8977867 | Message queue module | 3091 | 1270 |
| 14:02:39.0339830 | WebSocket byte transport and codec | 29744 | 8028 |

Vite emits one ES library chunk per fixture. The byte counts describe these specific fixture imports. Gzip uses Node defaults. #18 owns comparable consumer workloads and performance budgets.
