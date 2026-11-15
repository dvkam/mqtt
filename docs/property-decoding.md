# Property decoding

One reader in `src/wireProperties.ts` decodes and checks the property section of every packet. `PacketDecoder`, which the browser client uses, and the Node decoder both call it, so a malformed section gives the same error class, code and message on every platform. `test/property-decode-parity.test.ts` pins that with one vector for each row below.

Before #169 the Node decoder walked the property bytes with its own tables and then handed the frame to the codec, which read them again with different messages.

## Outcomes

`<KIND>` is the uppercase packet name.

| Defect | Outcome |
| --- | --- |
| Ill-formed UTF-8 or U+0000 in a property string | `Invalid MQTT <KIND> property UTF-8` |
| Property bytes cut short | `Truncated MQTT <KIND> property` |
| Property Length past the packet, or bytes after it in a packet without payload | `Invalid MQTT <KIND> property length` |
| Unknown identifier, or one MQTT 5 assigns to another packet | `Invalid MQTT <KIND> property identifier` |
| Repeated property other than User Property and Subscription Identifier | `Duplicate MQTT <KIND> property` |
| Repeated Topic Alias | `ProtocolInputError` 0x82, `Duplicate MQTT Topic Alias property` |
| Non-canonical or over-long variable integer | `Non-canonical MQTT <KIND> property integer`, `Malformed MQTT <KIND> property integer` |
| A flag or Maximum QoS above 1 | `Invalid MQTT property value` |
| Zero Receive Maximum, Maximum Packet Size or Subscription Identifier | `Invalid zero MQTT property value` |
| Topic Alias 0 | `ProtocolInputError` 0x94, `Invalid MQTT Topic Alias` |
| Empty or wildcard Response Topic | `ProtocolInputError` 0x82, `Invalid MQTT Response Topic` |
| Ill-formed or cut-short PUBLISH Topic Name | `Invalid MQTT PUBLISH topic UTF-8`, `Truncated MQTT PUBLISH topic` |

The Node clients reported these messages before. The browser decoder reported different ones: a `TypeError` from `TextDecoder`, `Truncated MQTT field`, `Trailing MQTT bytes`, `Unsupported MQTT property <id>`, `Invalid MQTT <KIND> property <id>`, named messages such as `Invalid Reason String property`, and a `RangeError` for a zero value. A Topic Alias in a packet other than PUBLISH was a `ProtocolInputError` 0x82 in the browser and is now `Invalid MQTT <KIND> property identifier`. A nonzero Topic Alias in a PUBLISH is still rejected with 0x94, because the clients negotiate no alias.

## UTF-8

`decodeUtf8` checks and decodes a string in one pass and uses no Node API. A string of at most 64 bytes that is all ASCII is built directly. Any other string goes through a fatal `TextDecoder`, and a zero byte or a decoding failure gives the named error. The test compares it with `isUtf8` from `node:buffer` and a fatal `TextDecoder` for every one-byte and two-byte sequence, the three-byte and four-byte boundaries, and strings on both sides of the 64-byte limit.

## Measurements

Node 26.13.0 on Linux x64 in WSL2, AMD Ryzen 5 3600. `test/bench/node-property-decode.ts` pushes 2,000 copies of one packet through `NodePacketDecoder` per batch. It warms up for 10 batches and reports the median of 40, with a garbage collection before each. Each row lists three runs. "Before" is `main` at d83bd2b.

Run `pnpm build`, then `node --expose-gc test/bench/node-property-decode.ts`.

| Workload | Bytes | Before, packets per second | After, packets per second |
| --- | ---: | --- | --- |
| PUBLISH without properties | 270 | 305,491, 302,551, 305,990 | 303,974, 290,309, 300,361 |
| PUBLISH with publisher properties | 418 | 68,512, 67,803, 68,218 | 162,082, 166,998, 163,196 |
| CONNACK with every broker property | 173 | 57,363, 59,567, 59,446 | 165,821, 166,356, 158,592 |

The medians are 305,491 and 300,361 for the plain PUBLISH, 68,218 and 163,196 for the PUBLISH with properties, and 59,446 and 165,821 for the CONNACK. The plain PUBLISH has no property bytes to read, so it does not change beyond run-to-run variation.

On `main` with the Node validator switched off, the same workloads ran at 310,890, 93,995 and 80,193 packets per second. So about a third of the gain on property-heavy packets comes from reading the bytes once. The rest comes from reading scalars by index, where the old reader made a `subarray` for each byte, and from the ASCII path.

These numbers exclude the socket, the session and the application callback. They measure one process on one machine, with no allocation or heap measurement. The browser decoder uses the same reader, but no browser run was recorded.
