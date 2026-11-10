# Native write admission and control reserve

The supported TCP, Node WS/WSS and browser clients reserve part of their observed native write budget for control packets. Publications can use `maxBufferedBytes - reservedControlBytes`; controls can use the full budget. The check includes bytes already queued, uses subtraction and rejects excess before native send. There is no waiting queue or priority scheduler.

| Option               | Default                                                       | Accepted values                          |
| -------------------- | ------------------------------------------------------------- | ---------------------------------------- |
| maxBufferedBytes     | 1 MiB                                                         | Positive safe integer                    |
| reservedControlBytes | Smaller of 128 KiB and one quarter of the total, rounded down | Safe integer from zero through the total |

Settings are validated and captured before acquiring a socket. Later mutation of the original options does not change the active budget. Set the reserve to zero to use the full budget for publications. A reserve equal to the total excludes nonempty publication writes. Very small totals can have zero default reserve and may not fit an MQTT CONNECT.

At the standard defaults, a publication's native charge can be at most 896 KiB. The separate 1 MiB outstanding-publication allowance does not guarantee that a publication fits the native budget. Larger workloads must configure both limits where necessary. The existing packed 8 MiB EOF probe sets both allowances to 16 MiB to preserve that validation workload.

## Accounting units

| Adapter | Observed queue        | Charge for a new application send                                |
| ------- | --------------------- | ---------------------------------------------------------------- |
| TCP     | Socket writableLength | Complete generated MQTT packet bytes                             |
| Node ws | bufferedAmount        | Generated MQTT packet plus its masked WebSocket frame header     |
| Browser | Native bufferedAmount | Encoded MQTT message payload bytes, matching the browser counter |

The pinned Node ws path sends uncompressed Buffer messages in one masked frame. Its header is six bytes below 126 payload bytes, eight below 65,536, and fourteen otherwise. The check includes that header for both publications and controls. Browser counters exclude WebSocket framing, so browser accounting intentionally uses different units.

These checks bound the admission projection at the time of the call. Automatic WebSocket close/pong frames, TLS records, kernel buffers, receive allocation, application references and later native activity are outside the policy. Encoding occurs before the native check and can allocate temporary bytes. The earlier publication pool limits publication payload work before encoding. Invalid or negative live counters reject admission.

## Ordering and outcomes

Reserved capacity means admission room, not control priority or latency. A control packet cannot overtake queued data or a partial native write. Other controls can consume the reserve. A control larger than the remaining space still fails under the existing operation contract. A native publication budget refusal leaves the session usable when the adapter can establish that it refused the exact attempt before submission. A refused QoS 1 publication releases its identifier, broker quota and publication budget without waiting for PUBACK. A prior terminal failure still takes precedence.

The raw browser byte transport keeps its previous behavior for `send(bytes)`, which uses the full budget. It also accepts `send(bytes, 'publication')` or `send(bytes, 'control')`. Raw callers own this classification because byte chunks may contain fragments or coalesced packets. The supported browser client supplies the classification from its packet object. WriteTraffic is exported from mqtt/browser as a type.

## Controlled validation observations

Source pin is 47432a7. The local run used Node 26.13.0 and ws 8.22.1 in Ubuntu 24.04 under WSL. From that checkout, reproduce the real corked checks with `pnpm exec vitest run test/tcp-client.test.ts test/websocket-client.test.ts -t 'reserves native|reserves framed'`. The supported browser and controlled-counter checks are in test/browser-client.test.ts, test/browser-transport.test.ts and test/websocket-client.test.ts.

The TCP test corks a real client socket with a total of 32 bytes and an eight-byte reserve. A 24-byte publication fills its allowance; an excess publication leaves writableLength at 24. PINGREQ adds two bytes to 26. The peer sees no new command before uncorking, then receives publication before ping.

The Node ws corked tests use a sixteen-byte reserve and verify these exact frame charges:

| MQTT bytes | Masked header bytes | Observed queued frame bytes |
| ---------: | ------------------: | --------------------------: |
|          6 |                   6 |                          12 |
|        125 |                   6 |                         131 |
|        126 |                   8 |                         134 |
|      65535 |                   8 |                       65543 |
|      65536 |                  14 |                       65550 |

Each case rejects a larger publication before native growth, admits the exact frame and queues an eight-byte framed ping behind it. The WebSocket classification tests also use simulated live counters while exchanging real packets. These deterministic observations establish admission and ordering at the tested seam. They are not throughput or sustained-backpressure measurements. The finite model checks admission projections; concrete tests supply framing and native behavior. The mixed-packet soak remains under #11 with #18.

## QoS 1 refusal before submission

In the TCP regression, a 24-byte QoS 0 write fills the corked publication allowance. A refused QoS 1 request leaves writableLength at 24 bytes and releases its identifier. The two-byte PINGREQ fits behind the queued write. After uncorking, a second QoS 1 request succeeds on the same connection with broker Receive Maximum one.

The Node WebSocket and browser client tests hold the native counter at the publication allowance while checking control and retry on the same connection. The packed browser test runs the public adapter against a scripted peer in Chromium, Firefox and WebKit. The peer observes PINGREQ, the second QoS 1 PUBLISH, another PINGREQ and DISCONNECT in order. The browser regression also replays the Error from an earlier budget refusal through a later native send. The later failure retires the session because its write outcome is uncertain.

Run the focused source checks with `pnpm exec vitest run test/tcp-client.test.ts test/native-qos-one-budget.test.ts test/qos1-publish.test.ts`. These checks exercise admission and cleanup at controlled queue sizes.
