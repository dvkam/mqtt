# CONNACK property byte validation

The supported TCP and Node WebSocket clients validate CONNACK property bytes before the portable codec converts strings. They share the private NodePacketDecoder. No public option or export changes.

The recorded failing frames are:

    20 0a 00 00 07 26 00 01 c0 00 01 78
    20 0a 00 00 07 26 00 01 00 00 01 78

The first key contains ill-formed UTF-8. The second contains U+0000. Previously, native decoding accepted them as a replacement-character key and a null-character key. The portable decoder already rejected both. The rules come from [MQTT 5 sections 1.5.4 and 1.5.7](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html).

## Placement and behavior

The guard runs after bounded frame assembly and before the native parser receives the completed remainder. CONNACK has no payload, so its declared property section must end at the frame boundary. Each fixed-width or length-prefixed read must stay inside that section.

The walker recognizes all 17 CONNACK property identifiers. It checks canonical one-to-four-byte variable integers for the section length and identifiers. It validates original string bytes with node:buffer.isUtf8 and rejects NUL in both User Property strings and the other string fields. Authentication Data is length-checked and skipped as binary. The walker uses views over the existing frame and does not allocate a second frame or decode property strings itself.

A failure enters the existing decoder rejection and input retirement path. It retains the first Error, stops the coalesced suffix and closes the native transport. During opening, malformed properties reject connect without accepting a session. They use the existing generic malformed-input close path, not a new reason-coded DISCONNECT contract. An earlier accepted refusal retains its reason even if malformed bytes follow.

Valid empty strings, literal U+FFFD, U+FEFF and multibyte strings retain their native representation. Repeated User Properties and mutable native binary Buffers remain unchanged.

## Evidence and limits

The first run failed 18 of 24 cases. Adding property-boundary vectors produced 24 failures in 39 cases before the source change. The final file has 46 cases, including all splits of the recorded key/value failures, a two-byte length vector, both native clients, browser comparison, first-error identity and actual peer closure before fixture cleanup. The six-file focused set passes 137 tests.

Four restored source faults remove string validation, span bounds, canonical integer checks or identifier rejection. Each fails a regression. The first bounds fault survived because native parsing still rejected the malformed packets. Three cases now require a controlled CONNACK framing Error instead of fallback native RangeError or unrelated parser messages. Those cases detect removing the local span check. The test documents the rejection contract rather than claiming native fallback would accept every truncated packet.

NodeConnackProperties models validation before dispatch and a bounded cursor over two abstract reads. It classifies UTF-8 and property shapes abstractly. It does not prove the UTF-8 algorithm, the complete property table or JavaScript buffer operations. Concrete vectors cover those rules. NodePacketAdmission, NodeInputLifecycle and ConnectRefusal retain their existing framing, retirement and first-cause mappings.

The opaque Authentication Data fixture checks byte shape and retained representation. It does not establish a negotiated authentication exchange. Duplicate singleton properties, property-value legality, negotiated behavior and UTF-8 in other packet types remain under #9, #16 and #17. The portable codec still has its documented smaller property profile.

Run the concrete regressions with:

    pnpm exec vitest run test/connack-property-strings.test.ts

Run the pinned verification command described in the project-local verification skill. Broader allocation and throughput measurements remain under #18 and #118. This change makes no performance claim.

The [PUBLISH property guard](publish-property-validation.md) reuses the walker with a separate property end before binary payload. The CONNACK end-at-frame rule remains unchanged.
