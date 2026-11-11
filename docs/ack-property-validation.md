# ACK property string validation

The native decoder validates Reason String and User Property keys and values before mqtt-packet 9.0.2 converts them. This applies to PUBACK, PUBREC, PUBREL, PUBCOMP, SUBACK and UNSUBACK. TCP and Node WebSocket share the guard.

Independent malformed frames include:

    40 08 00 01 00 04 1f 00 01 c0
    90 0b 00 01 07 26 00 01 6b 00 01 00 00

The PUBACK contains ill-formed Reason String bytes. The SUBACK contains a null User Property value followed by a valid reason code. The string rules and layouts follow [MQTT 5 sections 1.5.4, 1.5.7 and 3.4 through 3.11](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html).

## Layout and failure behavior

Publication acknowledgments put properties after the two-byte packet identifier and one-byte reason code. Remaining Length 2 or 3 omits Property Length. Both abbreviated forms remain accepted, including an explicit nonzero reason code where legal. If properties are present, their declared end must equal the frame end.

SUBACK and UNSUBACK always have Property Length immediately after the packet identifier. Their reason-code payload follows the property section. A truncated property cannot borrow reason bytes, even if those bytes could complete a valid string.

All six packet types allow only Reason String and User Property shapes in this walker. The private reader keeps the existing UTF-8, NUL, canonical integer and section-bound checks. Valid empty strings, literal U+FFFD, U+FEFF, multibyte strings and repeated User Properties retain their native representations.

Validation precedes the retained parser callback. A malformed matching ACK cannot complete a pending publish, subscribe or unsubscribe operation. The generic error/close path preserves the first Error, delivers only the accepted packet prefix, stops the suffix and closes the native transport. Existing reason-code validation and protocol-error classification still run after valid properties. No new coded DISCONNECT contract is added.

## Evidence and limits

The initial run failed 86 of 161 cases. The expanded pre-fix run failed 102 of 189 cases. The final file has 206 ACK cases, including every split, long properties crossing two-byte length boundaries, compact forms, Unicode controls, pending public operations and actual native peer closure before fixture cleanup.

Six source faults remove string checks, local bounds, ACK validation, compact-form handling, the subscription offset distinction or the no-payload exact-end check. All fail regressions and were restored. A separate replay shows that treating subscription ACKs as compact confirmations skips their required property-length check.

AckPropertyLayout models the optional-versus-required validation decision for two ACK families and body sizes 2, 3 and 4. It checks validation before dispatch, no malformed property dispatch and preservation of compact forms. The existing property-reader model covers bounded reads with and without a trailing payload. UTF-8 classification, concrete offsets, packet identifiers and reason-code semantics remain concrete-test assumptions.

Raw PUBREC, PUBREL and PUBCOMP fixtures prove decoder behavior only. They do not add public QoS 2 support. The supported public operations remain QoS 1 publish, subscribe and unsubscribe. Portable comparisons run through the existing profile and do not extend it.

Duplicate singleton fields, scalar legality, DISCONNECT properties and the remaining negotiated behavior stay under #9, #16 and #17. The next string-validation slice is DISCONNECT, with its zero-length and reason-only forms preserved.

Run:

    pnpm exec vitest run test/ack-property-strings.test.ts

The guard reuses the private property walker. No second frame is allocated by this validation, but temporary functions and views can still have a cost. Allocation and throughput effects remain unmeasured under #18 and #118.

[Packed observations](baseline/ack-property-checks.md) record all six integration timing rows and their limits.
