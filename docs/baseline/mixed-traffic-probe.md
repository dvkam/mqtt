# Mixed traffic observations

Measured on 8 November 2026. Source commit `84d1f5ad04d5be0d83931c60d441216afe2e1e7c`. The [method and limits](../mixed-traffic-probe.md) apply to every observation below. Raw process output remains local in `work/mixed-results.jsonl` and `work/mixed-gc-calibration.json`.

## Environment

| Field | Value |
| --- | --- |
| runtime | v26.13.0 |
| platform | linux |
| architecture | x64 |
| kernel | 6.18.54.1-microsoft-standard-WSL2 |
| cpu | AMD Ryzen 5 3600 6-Core Processor |
| parallelism | 12 |
| ws | 8.22.1 |
| mqttPacket | 9.0.2 |

Each observation uses a fresh process. Order was TCP/WS, WS/TCP, TCP/WS. Each process forces GC before setup. No formal checker, compiler or test suite ran alongside these measurements.

## Individual runs

| Transport | Repetition | UTC start | UTC finish | Elapsed ms | Observation window ms | Memory samples |
| --- | --- | --- | --- | --- | --- | --- |
| tcp | 1 | 2026-11-08T20:33:30.198Z | 2026-11-08T20:33:39.463Z | 9224.508099 | 9225.024019 | 917 |
| websocket | 1 | 2026-11-08T20:33:41.233Z | 2026-11-08T20:33:50.556Z | 9272.557123 | 9273.036908 | 921 |
| websocket | 2 | 2026-11-08T20:33:52.350Z | 2026-11-08T20:34:01.620Z | 9223.397454 | 9223.900651 | 916 |
| tcp | 2 | 2026-11-08T20:34:03.400Z | 2026-11-08T20:34:12.671Z | 9232.530486 | 9232.99062 | 916 |
| tcp | 3 | 2026-11-08T20:34:14.423Z | 2026-11-08T20:34:23.728Z | 9266.849317 | 9267.310174999999 | 920 |
| websocket | 3 | 2026-11-08T20:34:25.475Z | 2026-11-08T20:34:34.819Z | 9297.483415 | 9297.973114 | 923 |


Every run used 1,000 rounds, burst 16, eight admitted publications per round, 256 payload bytes, 1 ms echo delay, 1 ms native read pause and 20,000 observer iterations per echo. Every run attempted 16,000 publications, accepted 8,000, rejected 8,000 for capacity and received 8,000 echoes. Every run recorded 1,000 controls, 101 peer subscriptions and 900 peer pings. ID checksum was 63,964,000 and work checksum was 1,667,235,288 in every run.

| Transport | Repetition | Round entry peak | Pending echo peak | Final entries | Peer echo queue peak | Peer echo queue final | Native write observations | Native observed peak bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tcp | 1 | 16 | 8 | 0 | 7 | 0 | 18000 | 0 |
| websocket | 1 | 16 | 8 | 0 | 8 | 0 | 18000 | 0 |
| websocket | 2 | 16 | 8 | 0 | 8 | 0 | 18000 | 0 |
| tcp | 2 | 16 | 8 | 0 | 7 | 0 | 18000 | 0 |
| tcp | 3 | 16 | 8 | 0 | 7 | 0 | 18000 | 0 |
| websocket | 3 | 16 | 8 | 0 | 8 | 0 | 18000 | 0 |


The native counter was zero at every before/after write observation. That result describes this workload and observation points. It does not establish zero buffering, allocation or memory use.

## Latency observations

All values below are milliseconds. Each summary preserves the sample count, minimum, nearest-rank p50 and p99, and maximum.

### sendLatencyMs

| Transport | Repetition | Count | Minimum | p50 | p99 | Maximum |
| --- | --- | --- | --- | --- | --- | --- |
| tcp | 1 | 8000 | 0.07567199999903096 | 0.12645300000076531 | 0.35528100000010454 | 2.086091000000124 |
| websocket | 1 | 8000 | 0.08869999999842548 | 0.17857199999980367 | 0.4983279999999013 | 2.3333939999999984 |
| websocket | 2 | 8000 | 0.08739700000114681 | 0.17558400000007168 | 0.48440400000026784 | 2.3314210000000912 |
| tcp | 2 | 8000 | 0.07460999999966589 | 0.1248169999998936 | 0.37195100000008097 | 1.9707300000000032 |
| tcp | 3 | 8000 | 0.07490700000016659 | 0.12811099999998987 | 0.3711519999997108 | 2.016685999999936 |
| websocket | 3 | 8000 | 0.08808099999987462 | 0.1795799999999872 | 0.49334399999997913 | 2.202205999999933 |


### echoLatencyMs

| Transport | Repetition | Count | Minimum | p50 | p99 | Maximum |
| --- | --- | --- | --- | --- | --- | --- |
| tcp | 1 | 8000 | 0.32544400000006135 | 5.049568999999792 | 9.753233999999793 | 12.927126000000044 |
| websocket | 1 | 8000 | 0.38319700000101875 | 5.1159490000000005 | 9.843561000000136 | 11.7449459999998 |
| websocket | 2 | 8000 | 0.3420880000012403 | 5.110177000000476 | 9.862306999999873 | 11.972504000000072 |
| tcp | 2 | 8000 | 0.27360700000008364 | 5.041317999999592 | 9.788306999999804 | 13.071118999999953 |
| tcp | 3 | 8000 | 0.3088479999996707 | 5.0611360000002605 | 9.863963999999669 | 14.426748999999973 |
| websocket | 3 | 8000 | 0.3820300000006682 | 5.127209000000221 | 9.906920999999784 | 13.569569000000001 |


### controlLatencyMs

| Transport | Repetition | Count | Minimum | p50 | p99 | Maximum |
| --- | --- | --- | --- | --- | --- | --- |
| tcp | 1 | 1000 | 0.20346499999868684 | 1.3040729999993346 | 1.7316099999998187 | 6.191875999999866 |
| websocket | 1 | 1000 | 0.10289899999952468 | 0.1491969999997309 | 1.1163289999994959 | 1.6130430000000615 |
| websocket | 2 | 1000 | 0.10229700000127195 | 0.14551599999958853 | 1.0858180000004722 | 2.723124000000098 |
| tcp | 2 | 1000 | 0.1614210000007006 | 1.3056280000000697 | 1.8302340000000186 | 4.703573000000006 |
| tcp | 3 | 1000 | 0.16731499999877997 | 1.3052800000004936 | 1.826759999999922 | 3.42278599999986 |
| websocket | 3 | 1000 | 0.10327700000016193 | 0.15041199999905075 | 1.076082999999926 | 2.6255459999999857 |


### observerLatencyMs

| Transport | Repetition | Count | Minimum | p50 | p99 | Maximum |
| --- | --- | --- | --- | --- | --- | --- |
| tcp | 1 | 8000 | 0.045283999999810476 | 0.0473840000004202 | 0.0891950000000179 | 0.7190630000000056 |
| websocket | 1 | 8000 | 0.045599000000947854 | 0.047399000000950764 | 0.08108799999990879 | 0.7249799999999595 |
| websocket | 2 | 8000 | 0.04549800000131654 | 0.04730600000038976 | 0.09329200000001947 | 0.6864369999998416 |
| tcp | 2 | 8000 | 0.045600999999805936 | 0.047802000000046974 | 0.09211300000060874 | 0.7078799999999319 |
| tcp | 3 | 8000 | 0.045404000000417 | 0.0473920000004 | 0.09328399999958492 | 0.7308040000000346 |
| websocket | 3 | 8000 | 0.04529099999854225 | 0.04750400000011723 | 0.09279000000015003 | 0.7100669999999809 |


## Memory observations

Values are bytes. Each peak is the maximum sampled value for that field. Fields can peak at different times. `external` includes `arrayBuffers`; do not add them. The 10 ms samples include peer, probe and retained latency history. They do not measure allocation volume or client-only retained memory.

### baseline

| Transport | Repetition | RSS | Heap total | Heap used | External | Array buffers |
| --- | --- | --- | --- | --- | --- | --- |
| tcp | 1 | 84922368 | 21344256 | 16049544 | 3966926 | 905905 |
| websocket | 1 | 85913600 | 21606400 | 16296976 | 3975293 | 914272 |
| websocket | 2 | 85520384 | 21868544 | 16269632 | 3975293 | 914272 |
| tcp | 2 | 85164032 | 21344256 | 16092912 | 3966926 | 905905 |
| tcp | 3 | 84623360 | 21606400 | 16024760 | 3966926 | 905905 |
| websocket | 3 | 85704704 | 21868544 | 16260960 | 3975293 | 914272 |


### sampledPeak

| Transport | Repetition | RSS | Heap total | Heap used | External | Array buffers |
| --- | --- | --- | --- | --- | --- | --- |
| tcp | 1 | 118710272 | 51605504 | 36380288 | 4558963 | 1497902 |
| websocket | 1 | 119582720 | 51867648 | 36866016 | 4652163 | 1583756 |
| websocket | 2 | 120692736 | 52129792 | 36909344 | 4648121 | 1587060 |
| tcp | 2 | 118611968 | 51343360 | 36154800 | 4562237 | 1491052 |
| tcp | 3 | 117542912 | 51343360 | 36316496 | 4556083 | 1495022 |
| websocket | 3 | 120463360 | 52129792 | 36951544 | 4647015 | 1585954 |


### last

| Transport | Repetition | RSS | Heap total | Heap used | External | Array buffers |
| --- | --- | --- | --- | --- | --- | --- |
| tcp | 1 | 118710272 | 51605504 | 28819568 | 4172313 | 1111252 |
| websocket | 1 | 119582720 | 51867648 | 27451544 | 4039093 | 978032 |
| websocket | 2 | 120692736 | 52129792 | 27953520 | 4054881 | 993820 |
| tcp | 2 | 118611968 | 51343360 | 28901992 | 4173677 | 1112616 |
| tcp | 3 | 117542912 | 51343360 | 28859672 | 4173129 | 1112068 |
| websocket | 3 | 120463360 | 52129792 | 27505416 | 4041839 | 980778 |


## GC observations

Entries count only if their start time falls within the observation window. Durations are milliseconds.

| Transport | Repetition | Count | Total ms | Maximum ms |
| --- | --- | --- | --- | --- |
| tcp | 1 | 21 | 19.36978100003762 | 2.918247000001429 |
| websocket | 1 | 24 | 22.1728460000013 | 2.903598000004422 |
| websocket | 2 | 24 | 21.84632299997611 | 3.145728000003146 |
| tcp | 2 | 21 | 20.231385999984923 | 2.9258739999932004 |
| tcp | 3 | 21 | 19.215400999979465 | 2.6065700000035577 |
| websocket | 3 | 24 | 22.081486999974004 | 3.259604999999283 |


## Forced GC calibration

The calibration ran from outside the checkout using the emitted JavaScript entry. It used the same source and environment. It observed one forced GC entry. It did not run MQTT traffic.

| Field | Value |
| --- | --- |
| observationWindowMs | 4.634347000000162 |
| nativeWriteSamples | 0 |
| nativeObservedPeakBytes | 0 |
| memory samples | 2 |
| sample interval ms | 10 |
| gc count | 1 |
| gc totalMs | 3.705178000003798 |
| gc maximumMs | 3.705178000003798 |


| Phase | RSS | Heap total | Heap used | External | Array buffers |
| --- | --- | --- | --- | --- | --- |
| baseline | 73359360 | 12980224 | 8584368 | 3412112 | 315569 |
| sampledPeak | 73359360 | 12980224 | 8593088 | 3412152 | 315569 |
| last | 73359360 | 12980224 | 7647816 | 3412152 | 315492 |

