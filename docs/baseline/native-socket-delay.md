# Native socket delay experiment

Issue #136 follows the approximately 41 ms TLS echo observations from #135. The installed package at commit 40548875dd768568841a2e2a3e949ecb68a4f950 was built and packed once. Six fresh broker runs alternated the original installed JavaScript and a one-line installed-artifact patch calling socket.setNoDelay(true) immediately after socket construction. The source tree was unchanged during the experiment.

The run order was default, no-delay, no-delay, default, default, no-delay. Each run used Node 26.13.0, native Mosquitto 2.0.18, WSL2, the same tarball and the packed WS/TLS broker script. Every run passed MQTT 5 exchanges, certificate rejection cases, WS/WSS and proxy checks. TLS and mutual TLS each timed five echoes after the protocol assertions. These small loopback observations support the socket default; they do not establish production throughput, tail latency or allocation behavior. The runner's p99 field contains a five-sample statistic, not a reliable tail estimate.

| Run | Session | Echoes | Echoes per second | Reported p99 ms |
| --- | --- | ---: | ---: | ---: |
| 1-default | TLS | 5 | 116.268 | 41.472800 |
| 1-default | Mutual TLS | 5 | 115.365 | 41.786200 |
| 2-no-delay | TLS | 5 | 2909.260 | 0.441080 |
| 2-no-delay | Mutual TLS | 5 | 3075.042 | 0.482050 |
| 3-no-delay | TLS | 5 | 3223.419 | 0.464724 |
| 3-no-delay | Mutual TLS | 5 | 3209.323 | 0.474727 |
| 4-default | TLS | 5 | 115.598 | 41.804968 |
| 4-default | Mutual TLS | 5 | 115.673 | 41.729308 |
| 5-default | TLS | 5 | 115.998 | 41.715562 |
| 5-default | Mutual TLS | 5 | 116.014 | 41.699461 |
| 6-no-delay | TLS | 5 | 3175.500 | 0.453479 |
| 6-no-delay | Mutual TLS | 5 | 3116.430 | 0.484825 |

Default-socket reported p99 values ranged from 41.473 to 41.805 ms. No-delay values ranged from 0.441 to 0.485 ms. Delayed acknowledgments interacting with Nagle buffering are a plausible explanation; no packet capture was taken to establish the kernel mechanism.

Production calls the native setNoDelay(true) API for both plaintext TCP and TLS before the opening event. Two tests first failed with zero native configuration calls, then passed with the change. Existing write admission, frame order and teardown remain unchanged. No timing threshold was added to CI.

Raw logs remain local as work/tcp-delay-{1-default,2-no-delay,3-no-delay,4-default,5-default,6-no-delay}.log. Reproduce by installing the packed tarball in a clean consumer, running test/packed/mosquitto-ws.sh with MQTT_CONSUMER_DIR pointing to it, and comparing builds with and without the single setNoDelay call. The broker guide documents native and pinned-container setup. Wider load and network measurements remain under #18 and #118.
