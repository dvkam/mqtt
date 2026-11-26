# TCP burst writes

The TCP writer sends the first packet immediately. A second write in the same turn corks the socket. One microtask uncorks it, and Node can write the remaining packets together. Each write keeps its callback and contributes to `writableLength`. This preserves MQTT packet order and control headroom. [#157](https://github.com/dvkam/mqtt/issues/157)

If the next packet would exceed the native write budget, the core flushes a corked tail and checks `writableLength` again. A writable socket can submit that tail before applying the limit to the next packet. A genuinely backpressured socket still reports the original limit error. The private flush applies to plain TCP.

Node 26.13.0 and V8 14.6.202.34-node.40 ran against pinned Mosquitto 2.0.22. Both sides used `set_tcp_nodelay true`. The TLS listener used a local CA and a certificate for `localhost`. Five pairs alternated order. Each burst run warmed up with five bursts and timed 50 bursts of 1,000 checked QoS 0 echoes. Isolated runs checked 100,000 TCP and 50,000 TLS echoes per process.

| Workload | Variant | Echoes/s | p50 ms | p90 ms | p95 ms | p99 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| TCP burst | Before | 89,817 (59,134 to 105,409) | 5.481 | 9.361 | 11.940 | 24.606 (11.605 to 41.041) |
| TCP burst | After | 94,999 (88,994 to 100,997) | 5.085 | 7.907 | 8.831 | 12.881 (10.065 to 26.432) |
| TCP isolated | Before | 22,844 (18,888 to 24,716) | 0.037 | 0.056 | 0.083 | 0.188 (0.172 to 0.212) |
| TCP isolated | After | 21,416 (20,097 to 25,119) | 0.037 | 0.058 | 0.090 | 0.195 (0.162 to 0.217) |
| TLS burst | Before | 90,886 (75,950 to 98,455) | 5.393 | 8.423 | 9.669 | 12.568 (11.434 to 25.330) |
| TLS burst | Cork experiment | 89,527 (65,197 to 98,644) | 5.670 | 9.017 | 10.141 | 13.331 (9.648 to 30.283) |
| TLS isolated | Before | 16,738 (14,378 to 18,227) | 0.047 | 0.078 | 0.108 | 0.229 (0.196 to 0.254) |
| TLS isolated | Cork experiment | 16,654 (14,679 to 17,550) | 0.046 | 0.082 | 0.115 | 0.254 (0.182 to 0.268) |

A separate `strace` run counted socket writes for one 1,000-message burst plus CONNECT, SUBSCRIBE and DISCONNECT. Plain TCP went from 1,003 `write` calls to four `write` calls and one `writev`. Both TLS runs made six `write` calls and one `writev`. The throughput and latency ranges overlap. The selected implementation applies corking to plain TCP. Syscall counts do not measure TCP segments.

One resource run per TCP variant measured 100 bursts with a 1 ms event-loop delay sampler. Client system CPU was 366 ms before and 175 ms after. Loop delay p50, p90, p95, and p99 measured 7.49, 12.35, 16.52, and 18.43 ms before and 1.00, 4.25, 4.92, and 9.14 ms after. Post-GC heap was about 10.9 MB on both runs. These single-run observations include the fixtures and provide no run-to-run range.

Copy `test/bench/packed-tcp-burst.ts` under `bench/` and `test/experiments/latencies.ts` under `experiments/` into each installed consumer. Run the copies in alternating order. Set `MQTT_TEST_CA` to the local broker CA for TLS. Run resource sampling and syscall tracing separately.

```sh
MQTT_TEST_PORT=18882 node bench/packed-tcp-burst.ts
MQTT_TEST_PORT=18882 MQTT_TEST_RESOURCES=1 MQTT_TEST_BURSTS=100 node --expose-gc bench/packed-tcp-burst.ts
MQTT_TEST_PORT=18882 MQTT_TEST_BURSTS=1 MQTT_BURST_WARMUP=0 \
  strace -f -yy -s 0 -e trace=write,writev,sendto,sendmsg,sendmmsg -o burst.strace node bench/packed-tcp-burst.ts
```

The real-socket test checks immediate submission, queued bytes, packet order through DISCONNECT, and cancellation before the tail flushes. [TCP tests](../../test/outgoing-tcp.test.ts)
