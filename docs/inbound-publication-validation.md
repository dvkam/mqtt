# Inbound publication validation

The supported TCP, Node WebSocket and browser clients reject an empty PUBLISH Topic Name without an alias and names containing either MQTT wildcard. The pending operation and later operations receive the same protocol error with code 0x82. Packets before the rejection keep their wire order. The client stops the suffix and attempts one DISCONNECT notice after accepting CONNACK. [MQTT 5 sections 3.3.2.1, 4.7 and 4.13](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

The clients omit Topic Alias Maximum from CONNECT, which gives an inbound maximum of zero. Any supplied Topic Alias is rejected with 0x94, including zero, one, 65,535 and an alias paired with an empty Topic Name. A value advertised by the broker applies to publications sent to that broker. It does not increase the client's inbound limit. The portable codec's current profile rejects aliased PUBLISH packets too. [MQTT 5 sections 3.1.2.11.5 and 3.3.4](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

The Node framer still checks the raw Topic Name bytes for malformed UTF-8 and NUL before the retained parser can replace invalid bytes. The portable codec uses a fatal UTF-8 decoder. Valid Unicode and binary payloads preserve their existing representation.

## Verification

Run the fixed-wire cases with:

```sh
pnpm exec vitest run test/inbound-publish-topic.test.ts
```

The tests use independent bytes through each public client. They check the coded error, a valid publication before the invalid name, suffix fencing, failure identity and the reason observed by the peer. The original run failed all nine new Topic Name cases. All twelve alias cases also failed before the alias guard was added. A fault that rejected only alias zero failed the nonzero-alias tests. The focused source run passed 144 tests.

The existing ParserAckNotice, NodeInputLifecycle and BrowserAckOrder models cover downstream ownership and retirement. Byte-level name validation and the exact reason codes are checked by the wire tests. This change adds no reconnect alias state.
