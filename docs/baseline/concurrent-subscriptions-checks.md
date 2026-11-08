# Concurrent subscription CI observations

These are individual validation observations from [PR #91's packed-consumer job](https://github.com/dvkam/mqtt/actions/runs/42526164608/job/128870144788) on 8 November 2026. The checked source is `734f210ed3130d87e46d7f8e5a0cce24abdfeba4`, including production commit `55245c701284267b16dec4ec1db01074ab876c99`. The job installed the packed tarball into a clean consumer. Its raw log is retained locally in `work/subscriptions-ci-packed.log`.

## Environment and method

The runner used Ubuntu 26.04 image `20261101.186.1`, Node 26.13.0, pnpm 12.16.1 and Mosquitto 2.0.22. The source pins TypeScript 7.1.0-beta, Vite 8.3.6, mqtt-packet 9.0.2 and ws 8.22.1. The [workflow](../../.github/workflows/ci.yml) and `test/packed` fixtures define the setup and reproduction steps.

The broker fixture first completes two concurrent subscriptions and a ping through the public client. It then sends text QoS 0 publications serially and checks their echoed topic, payload and QoS 0. The timer for each sample starts before the publish/reply wait. Total elapsed time for the echo loop determines echoPerSecond. p99Ms is the nearest-rank latency over the recorded samples. These single CI runs include instrumentation and scheduling effects. They do not establish throughput or latency budgets for concurrent subscriptions.

## Echo observations

| UTC output time | Transport and fixture | Iterations | Echoes per second | p99 ms |
| --- | --- | ---: | ---: | ---: |
| 21:38:16.1733770 | TCP on port 18883 | 100 | 6317.311746321016 | 0.34386200000000144 |
| 21:38:18.8155159 | Node ws on port 18884 | 5 | 1991.1996938331465 | 0.945194999999984 |
| 21:38:19.2429496 | Node WSS on port 18885 with test CA | 5 | 2046.8139090010782 | 0.8711369999999761 |
| 21:38:20.0714842 | Node WSS on port 18886 with client certificate | 5 | 2092.617579996558 | 0.8384960000000206 |
| 21:38:24.3648162 | Node WSS through CONNECT proxy | 1 | 919.9598161552 | 1.0637609999999995 |

One sample makes the reported p99 equal to that sample; five samples make it the maximum. The transport cases have different iteration counts and TLS/proxy setup. Do not compare their rates as a controlled performance experiment. Connection, subscription and cancellation checks sit outside the timed echo loop. The workload has no sustained queue pressure and no QoS 1 acknowledgment exchange.

## Bundle observations

Vite emitted one ES library chunk per fixture with `write: false`. Sizes below count its code bytes. Gzip uses Node's gzipSync defaults. The assertions reject runtime imports, Node built-ins and browser external shims. These are fixture bundle sizes, not the npm tarball or a complete application.

| UTC output time | Fixture | Emitted bytes | Gzip bytes |
| --- | --- | ---: | ---: |
| 21:38:17.0825217 | `browser.mjs`, portable packet-client trace | 10208 | 3083 |
| 21:38:17.1412551 | `packed/stream-comparison.ts` | 32140 | Not reported |
| 21:38:17.1412551 | `experiments/message-queue.ts` | 3091 | 1270 |
| 21:38:18.2693024 | `websocket-browser.mjs`, byte transport and codec | 27797 | 7578 |

The portable trace includes the subscription registry. The byte-transport fixture does not establish the public browser client's complete bundle size. No before/after comparison or size threshold follows from these observations. #18 retains repeatable consumer bundle and performance budgets. The [subscription guide](../concurrent-subscriptions.md) describes the behavior and verification scope.
