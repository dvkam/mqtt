# Legacy fixture migration

The archived AVA files were outside the active test runner. Their useful assertions now run in Vitest, and the sample uses the supported MQTT 5 TCP client against an external broker. Aedes is no longer needed.

| Archived intent | Active coverage or follow-up |
| --- | --- |
| CONNECT defaults: protocol ID, version, clean session, keepalive, generated client ID and absent will/credentials | `client-baseline.test.ts` checks the legacy defaults with a scripted peer. Its protocol 4 and 5 cases also inspect CONNECT, QoS 0 PUBLISH and DISCONNECT. |
| Broker/client identity and disconnect cleanup | The baseline checks the supplied client ID and stream completion. `tcp-client.test.ts` and `websocket-client.test.ts` cover the supported adapters, aborts, refusals and teardown. |
| QoS 0 publication | The baseline checks the actual topic and Buffer payload, rather than comparing a received Buffer with a string. Packed Mosquitto checks exercise a real MQTT 5 exchange independently. |
| Malformed publication | The baseline calls through a JavaScript boundary with a missing topic. It checks promise rejection, the reported encoder error and the absence of an emitted PUBLISH. An empty MQTT 5 topic is not a suitable substitute because topic aliases can use it. |
| Timeout fixture | The archived executable case duplicated publication. Active tests cover CONNACK timeout and PINGRESP deadlines. Its commented private keepalive sketch remains work for #16 and #27. |
| Option validation placeholders | These had no executable assertions. #28, #30 and #52 retain the validation and normalization work. Protocol-specific client ID constraints belong to #15 and #19. |
| Commented QoS 1 sketch | #10 owns packet identifiers, acknowledgments and replay. No QoS 1 support is claimed by this migration. |
| Store and error-handling placeholders | #14 and #27 retain persistence and lifecycle work. #52 tracks the wider inherited comment audit. |

The old `message` publication field was not a valid payload assertion. The replacement checks `payload` and a genuinely missing topic. These tests preserve useful intent rather than treating every archived placeholder as implemented behavior.

## Run the example

Build the package, start a local Mosquitto broker, then run `node sample/sample.ts` with the pinned development Node runtime. `MQTT_HOST` defaults to `127.0.0.1`; `MQTT_PORT` defaults to `1883`.

The example subscribes to `example/echo`, publishes `hello`, prints the echoed payload, sends a ping and disconnects. The echo wait has a five-second deadline. It uses an anonymous plaintext local connection and is not a production security example. Compilation, lint and formatting checks include the sample.

Mosquitto remains the independent MQTT 5 integration broker under #23. Scripted peers provide exact packet and fault assertions. This migration does not add a broker implementation; a second broker can be evaluated under #23 if an interoperability gap calls for one.

Related: #42, #49 and #57.
