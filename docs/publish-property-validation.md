# PUBLISH property byte validation

The shared native decoder checks PUBLISH property strings before mqtt-packet 9.0.2 converts their original bytes. The TCP and Node WebSocket clients reject ill-formed UTF-8 and U+0000 in User Property keys and values, Content Type and Response Topic.

Independent failing User Property frames include:

    30 0b 00 01 61 07 26 00 01 c0 00 01 76
    30 0b 00 01 61 07 26 00 01 6b 00 01 00

The rules follow [MQTT 5 sections 1.5.4, 1.5.7 and 3.3.2.3](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html). The first frame contains ill-formed key bytes. The second contains a null character in the value. Native decoding previously accepted them.

## Property section and payload

After checking the raw Topic Name bytes, NodePacketDecoder skips the two-byte packet identifier for QoS 1 or 2. It then reads Property Length within the admitted frame. Each property read stays inside the declared property section, which can end before the payload.

The same private walker checks CONNACK and PUBLISH. Their shape maps contain 17 and 8 identifiers respectively. CONNACK still requires its property section to end at the frame boundary. PUBLISH leaves the remaining bytes untouched as payload. The walker validates canonical one-to-four-byte variable integers and rejects identifiers forbidden in that packet type.

Correlation Data is length-checked binary data. Neither its contents nor the payload are interpreted as property strings. Native mutable Buffer representations remain unchanged. Valid empty strings, literal U+FFFD, U+FEFF and multibyte text are preserved where their string field permits them.

Malformed properties use the existing generic error/close path. The input retains its first Error, fences the suffix and closes the native transport. Public regressions deliver a valid publication prefix but reject the malformed publication and later bytes. A malformed QoS 1 publication reaches neither the application callback nor PUBACK sending.

## Evidence and scope

The first test-first run failed 61 of 70 cases. The tests cover each string field at every split, field spans that try to borrow payload bytes, canonical lengths and identifiers, the QoS-dependent packet-identifier offset, and native buffer representations. Public TCP and Node WebSocket tests observe peer closure before fixture cleanup. Portable User Property comparisons preserve the existing browser profile.

Positive raw-decoder fixtures include QoS 2 and Topic Alias 1 to check byte layout and native representation. They do not add QoS 2 client support or negotiate inbound aliases. The existing public alias limit and reason 0x94 behavior remain unchanged.

The model distinguishes propertyEnd from frameEnd and includes a fault that reads payload while staying inside the frame. It checks only the documented finite cursor and validation abstraction. Concrete tests check byte arithmetic, UTF-8, field tables, native representations and physical cleanup.

Duplicate singleton properties, scalar value legality and Response Topic semantics beyond UTF-8 remain under #9 and #16. Payload Format Indicator semantics are also separate. Other acknowledgment and DISCONNECT string fields remain under #9. The portable codec's smaller property profile is unchanged.

Run the regressions with:

    pnpm exec vitest run test/publish-property-strings.test.ts test/connack-property-strings.test.ts

The [packed smoke observations](baseline/publish-property-checks.md) preserve each timing value and its limits. No allocation or performance advantage is claimed.

[ACK property validation](ack-property-validation.md) covers Reason String and User Properties before acknowledgment dispatch.
