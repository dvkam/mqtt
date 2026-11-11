# Property cardinality and scalar values

The native decoder rejects duplicate singleton properties before mqtt-packet can overwrite their first value. Tracking resets for each packet. User Property remains repeatable in every supported incoming packet. Subscription Identifier remains repeatable in PUBLISH, and every occurrence must be nonzero.

The guard checks the supported CONNACK, PUBLISH, acknowledgment and server DISCONNECT property tables. It accepts boolean properties only at 0 or 1. Receive Maximum, Maximum Packet Size and Subscription Identifier must be nonzero. Width-limited values retain their unsigned range, including Maximum Packet Size 4,294,967,295. Session Expiry, Message Expiry, Server Keep Alive and Topic Alias Maximum may be zero.

Response Topic must be nonempty and contain neither wildcard. Invalid Response Topic uses reason 0x82. Topic Alias zero retains reason 0x94, and a duplicate Topic Alias uses 0x82. Other duplicate and scalar failures keep the existing generic input-error policy. These checks do not negotiate aliases or add a new public error contract.

The rules follow [MQTT 5 property definitions and protocol errors](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html). They supplement the [property string checks](disconnect-property-validation.md).

## Ownership and compatibility

The existing private byte walker owns these checks. The portable codec already rejects duplicates and invalid integers for its smaller property profile. Its profile and implementation are unchanged. Session-level checks remain necessary for custom decoded packet transports that bypass byte decoding.

The singleton Set stores at most 16 CONNACK identifiers, 6 PUBLISH identifiers, 1 per acknowledgment kind and 2 DISCONNECT identifiers. Repeatable identifiers never enter it. This bounds tracker entries, not total decoder memory. The extra per-frame allocation has not been profiled under #18/#118.

Tests preserve same-key User Property value order and repeated Subscription Identifiers. They do not establish arbitrary ordering across different User Property keys. The retained parser's object representation is unchanged. Content Type and User Property strings may contain wildcard characters. Payload remains binary even when Payload Format Indicator is 1, since receiver payload validation is optional.

## Evidence and limits

The pre-fix run failed 55 of 89 initial cases. The final file has 96 cases, including every split, zero-valued first duplicates, unsigned limits, legal zeros, repeated values, per-frame reset and public-client failure ownership. Tests check that a malformed acknowledgment cannot complete an operation or deliver a later packet.

Eight deliberate source faults fail regressions. They remove duplicate detection, repeat exemptions, boolean validation, nonzero validation, Response Topic validation, zero-alias classification or duplicate-alias classification, or replace unsigned UInt32 reading with signed reading. All source faults were restored.

PropertyCardinalityValues explores 113 states with zero to three reads and three abstract value classes. It checks singleton and scalar rejection before dispatch, permitted repetition and bounded tracking. The full replay passes 39 configurations and detects 137 expected faults. The model assumes field classification and does not prove UTF-8, property-table completeness, concrete integer widths, precise error codes or socket cleanup. Concrete tests cover those stated behaviors.

The [connection agreement checks](connack-agreement.md) reject unsolicited authentication and inconsistent assigned identities. Negotiated capabilities, redirect behavior and wider portable profiles remain under #9, #12, #16 and #17. This change does not establish full MQTT conformance.

Run `pnpm exec vitest run test/property-cardinality-values.test.ts`. The [packed observations](baseline/property-value-checks.md) record installed-package checks and timing limits.
