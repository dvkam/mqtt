# Ready batches on the packed browser client

The packed consumer exercises single-message iteration and batches of up to 16 ready messages through the public browser WebSocket client. The experiment uses a scripted loopback MQTT 5 peer. Each mode gets its own connection. The application pauses reads while the peer sends two phases of 64 one-byte QoS 0 publications, paced eight at a time. After each phase marker, it leaves the queue stalled through a SUBACK, an outbound QoS 1 PUBACK and a PINGRESP. It then drains the ready backlog before telling the peer to start the next phase.

The gate checks the peer command order, all 128 offered and delivered sequence values, checksum 8128, and 64 messages with 1,216 accounted bytes at each stall. Iterator delivery takes 128 dispatches and batch delivery takes eight. Both modes finish with zero queued messages and bytes, zero observed listeners and timers, and a closed native WebSocket. The test catches a deliberate sequence corruption even though delivery and dispatch counts remain unchanged.

## Local observations

Harness commit `46e6a3a`, packed MQTT client commit `1709e70`, Node 26.13.0 under WSL2. The five fresh browser runs used Chromium 158.0.8127.18, Firefox 159.0 and WebKit 27.2. Runs two and four started with the batch session. Each cell summarizes ten phases for that engine and mode, in milliseconds.

Oldest age measures the first still-queued message from its application arrival to the start of drain. It includes peer pacing and the three control exchanges. Control durations measure from the API call until its promise settles. Drain duration starts at the same clock read used for oldest age. The table reports elapsed time with the browser's clock precision, so a recorded zero can mean below that clock's resolution.

| Engine   | Mode     |          Oldest age |           SUBACK |           PUBACK |         PINGRESP |            Drain |
| -------- | -------- | ------------------: | ---------------: | ---------------: | ---------------: | ---------------: |
| chromium | iterator | 37.80 (36.80–38.80) | 0.60 (0.50–0.70) | 0.50 (0.30–0.60) | 0.45 (0.30–0.60) | 0.10 (0.00–0.30) |
| chromium | batch-16 | 38.00 (36.40–39.10) | 0.60 (0.40–0.70) | 0.50 (0.40–0.60) | 0.40 (0.30–0.50) | 0.15 (0.10–0.30) |
| firefox  | iterator | 39.00 (38.00–41.00) | 1.00 (1.00–1.00) | 1.00 (0.00–2.00) | 1.00 (0.00–1.00) | 0.00 (0.00–0.00) |
| firefox  | batch-16 | 40.00 (38.00–41.00) | 1.00 (0.00–1.00) | 1.00 (0.00–2.00) | 1.00 (0.00–1.00) | 0.00 (0.00–1.00) |
| webkit   | iterator | 38.00 (37.00–41.00) | 1.00 (0.00–1.00) | 1.00 (0.00–1.00) | 1.00 (0.00–1.00) | 0.00 (0.00–1.00) |
| webkit   | batch-16 | 38.00 (36.00–40.00) | 1.00 (0.00–1.00) | 1.00 (0.00–1.00) | 1.00 (0.00–1.00) | 0.00 (0.00–1.00) |

The packed callback fixture was 21,563 minified bytes and 5,919 gzip bytes in these runs. Its import graph still excludes the experimental queue. This probe establishes dispatch counts and control progress with a held application queue. Timing ranges overlap across modes. It measures a scripted loopback peer, short control exchanges and explicit listener/timer bookkeeping. It does not measure native memory, GC retention, allocator pressure, an external broker or sustained network throughput.

## Reproduction

Run the normal packed consumer script with all three browser engines. Repeat five times, starting with the batch session in runs two and four.

```sh
node test/packed/browser-build.mjs "$consumer" chromium firefox webkit
MQTT_BATCH_ORDER=batch-first node test/packed/browser-build.mjs "$consumer" chromium firefox webkit
```

The `networkBatches` record holds both phase observations. Keep the raw output local. Each pair below lists phase one, then phase two, in milliseconds.

| Run | Engine   | Mode     |    Oldest age |      SUBACK |      PUBACK |    PINGRESP |       Drain |
| --: | -------- | -------- | ------------: | ----------: | ----------: | ----------: | ----------: |
|   1 | chromium | iterator | 38.80 / 37.80 | 0.70 / 0.60 | 0.50 / 0.40 | 0.30 / 0.40 | 0.20 / 0.10 |
|   1 | chromium | batch-16 | 39.10 / 38.10 | 0.60 / 0.50 | 0.40 / 0.50 | 0.40 / 0.40 | 0.20 / 0.10 |
|   1 | firefox  | iterator | 41.00 / 40.00 | 1.00 / 1.00 | 0.00 / 2.00 | 1.00 / 0.00 | 0.00 / 0.00 |
|   1 | firefox  | batch-16 | 41.00 / 40.00 | 1.00 / 1.00 | 0.00 / 1.00 | 1.00 / 1.00 | 0.00 / 0.00 |
|   1 | webkit   | iterator | 38.00 / 40.00 | 1.00 / 1.00 | 1.00 / 0.00 | 0.00 / 1.00 | 1.00 / 0.00 |
|   1 | webkit   | batch-16 | 40.00 / 37.00 | 0.00 / 1.00 | 1.00 / 0.00 | 1.00 / 1.00 | 0.00 / 0.00 |
|   2 | chromium | batch-16 | 38.80 / 37.80 | 0.70 / 0.60 | 0.50 / 0.50 | 0.50 / 0.30 | 0.20 / 0.10 |
|   2 | chromium | iterator | 37.20 / 38.20 | 0.50 / 0.50 | 0.50 / 0.50 | 0.40 / 0.50 | 0.00 / 0.10 |
|   2 | firefox  | batch-16 | 40.00 / 40.00 | 1.00 / 1.00 | 1.00 / 0.00 | 1.00 / 1.00 | 0.00 / 0.00 |
|   2 | firefox  | iterator | 38.00 / 40.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0.00 / 0.00 |
|   2 | webkit   | batch-16 | 39.00 / 38.00 | 1.00 / 1.00 | 0.00 / 1.00 | 1.00 / 0.00 | 1.00 / 0.00 |
|   2 | webkit   | iterator | 37.00 / 38.00 | 1.00 / 0.00 | 1.00 / 1.00 | 0.00 / 1.00 | 1.00 / 0.00 |
|   3 | chromium | iterator | 37.80 / 37.30 | 0.60 / 0.70 | 0.60 / 0.50 | 0.40 / 0.60 | 0.30 / 0.10 |
|   3 | chromium | batch-16 | 37.70 / 38.10 | 0.60 / 0.70 | 0.60 / 0.60 | 0.40 / 0.40 | 0.30 / 0.10 |
|   3 | firefox  | iterator | 39.00 / 41.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0.00 / 1.00 | 0.00 / 0.00 |
|   3 | firefox  | batch-16 | 40.00 / 41.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 0.00 |
|   3 | webkit   | iterator | 41.00 / 38.00 | 1.00 / 1.00 | 1.00 / 0.00 | 1.00 / 1.00 | 0.00 / 0.00 |
|   3 | webkit   | batch-16 | 40.00 / 38.00 | 1.00 / 0.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0.00 / 0.00 |
|   4 | chromium | batch-16 | 37.90 / 37.30 | 0.50 / 0.70 | 0.50 / 0.50 | 0.40 / 0.30 | 0.30 / 0.10 |
|   4 | chromium | iterator | 37.80 / 38.20 | 0.60 / 0.70 | 0.40 / 0.50 | 0.50 / 0.60 | 0.00 / 0.10 |
|   4 | firefox  | batch-16 | 39.00 / 40.00 | 0.00 / 1.00 | 1.00 / 2.00 | 1.00 / 0.00 | 0.00 / 0.00 |
|   4 | firefox  | iterator | 39.00 / 39.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 0.00 | 0.00 / 0.00 |
|   4 | webkit   | batch-16 | 36.00 / 36.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0.00 / 0.00 | 1.00 / 0.00 |
|   4 | webkit   | iterator | 39.00 / 37.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 0.00 | 0.00 / 0.00 |
|   5 | chromium | iterator | 36.80 / 37.20 | 0.50 / 0.60 | 0.60 / 0.30 | 0.30 / 0.50 | 0.20 / 0.00 |
|   5 | chromium | batch-16 | 38.30 / 36.40 | 0.60 / 0.40 | 0.50 / 0.60 | 0.40 / 0.30 | 0.30 / 0.10 |
|   5 | firefox  | iterator | 39.00 / 38.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0.00 / 1.00 | 0.00 / 0.00 |
|   5 | firefox  | batch-16 | 40.00 / 38.00 | 0.00 / 0.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0.00 / 0.00 |
|   5 | webkit   | iterator | 37.00 / 38.00 | 1.00 / 0.00 | 1.00 / 1.00 | 0.00 / 1.00 | 0.00 / 0.00 |
|   5 | webkit   | batch-16 | 38.00 / 39.00 | 1.00 / 0.00 | 1.00 / 1.00 | 0.00 / 1.00 | 1.00 / 0.00 |
