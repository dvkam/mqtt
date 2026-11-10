# Fixed-wire codec comparison

This run used Node 26.13.0 and eight fixed MQTT 5 inputs. Each streaming decoder received one whole packet and then the same bytes one at a time on a fresh instance. Both layouts produced the same outcome in all 40 streaming pairs. Opifex used its contiguous packet entry and ran once per input. The 88 observations record decode behavior. Throughput, allocations and browser size need separate runs.

The references are published mqtt-packet 9.0.2, that release with only `parser.js` replaced by the file at upstream commit `dd17095bbe52ac28bc96c831e69b0db4371da5a5`, published u8-mqtt-packet 0.4.1 and Opifex at `025d247a9397e0dba0625a456db7b8aa50e80069`. The parser overlay isolates the source changes from dependency changes. [mqtt-packet source](https://github.com/mqttjs/mqtt-packet/blob/dd17095bbe52ac28bc96c831e69b0db4371da5a5/parser.js) · [u8-mqtt-packet source](https://github.com/shanewholloway/js-u8-mqtt-packet) · [Opifex source](https://github.com/seriousme/opifex/tree/025d247a9397e0dba0625a456db7b8aa50e80069/mqttPacket)

| Input | Portable | Fork Node framer | mqtt-packet 9.0.2 | Upstream parser overlay | u8-mqtt-packet 0.4.1 | Opifex |
| --- | --- | --- | --- | --- | --- | --- |
| Canonical zero, PINGRESP | Accept | Accept | Accept | Accept | Accept | Accept |
| Canonical 128, PUBLISH | Accept | Accept | Accept | Accept | Accept | Accept |
| Zero in two bytes | Reject | Reject | Accept | Accept | Accept | Accept |
| Four in three bytes | Reject | Reject | Accept | Accept | Accept | Accept |
| Zero in five bytes | Reject | Reject | Reject | Reject | Accept | Reject |
| AUTH with omitted reason | Outside profile | Parser error | Parser error | Success reason 0 | Runtime TypeError | Packet too short |
| PUBLISH with repeated key and empty first value | Keeps both, ordered pairs | Drops the empty value | Drops the empty value | Keeps both, grouped by key | Drops the empty value | Keeps both, ordered pairs |
| Same properties with another key between them | Preserves the sequence | Drops the empty value | Drops the empty value | Keeps all values, grouped by key | Drops the empty value | Preserves the sequence |

The length inputs use `d0 00`, `30 80 01` followed by the topic and property bytes `00 01 61 00` and 124 zero payload bytes, `d0 80 00`, `30 84 80 00 00 01 61 00`, and `d0 80 80 80 80 00`. MQTT 5 limits Variable Byte Integers to four bytes and requires the shortest representation. The old Node framer accepted both short non-minimal encodings. The new guard detects a redundant zero terminal digit before allocating the compact remainder. [MQTT 5 sections 1.5.5 and 2.1.4](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

The AUTH input is `f0 00`. The success reason may be omitted at the packet level. The preview has no enhanced-authentication exchange, so accepting this wire shape alone would not support that feature. The User Property input is `30 11 00 01 61 0d 26 00 01 6b 00 00 26 00 01 6b 00 01 76`. The interleaved case uses `30 18 00 01 61 14 26 00 01 6b 00 00 26 00 01 78 00 01 61 26 00 01 6b 00 01 76`. The upstream parser overlay keeps the empty value but groups the two `k` values together, losing their position relative to `x`. [MQTT 5 sections 3.3.2.3.7 and 3.15.2.1](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

The next comparison can use the same wire vectors to evaluate a typed adapter for packet shapes and ordered properties before choosing a Node parser. Broader property validation, direction checks and performance comparisons remain under #9, #37 and #18.
