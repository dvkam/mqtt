# DISCONNECT property string validation

The shared native decoder validates DISCONNECT properties before interpreting the broker's reason. It checks Reason String, Server Reference and both User Property strings for ill-formed UTF-8 and U+0000.

The recorded malformed frames are:

    e0 06 00 04 1f 00 01 c0
    e0 09 00 07 26 00 01 00 00 01 76

The first formerly became a replacement-character Reason String. The second accepted a null User Property key. The rules follow [MQTT 5 sections 1.5.4, 1.5.7 and 3.14.2.2](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html).

## Placement and direction

Remaining Length 0 or 1 has no property section and keeps the existing parser path. Longer DISCONNECT packets start Property Length after the one-byte reason. Every field stays within the declared section, which must end exactly at the frame boundary.

The server-input map accepts three property identifiers. Session Expiry Interval is excluded because the Server must not send it on DISCONNECT. This does not change outgoing client properties or authentication negotiation.

The existing private walker now uses a packet-kind registry, preserving the prior CONNACK, PUBLISH and ACK maps. Valid empty strings, literal U+FFFD, U+FEFF, multibyte strings and repeated User Properties retain their native representation.

Malformed input fails before the native callback can turn it into a broker-disconnection reason. Public TCP and Node WebSocket tests verify the accepted publication prefix, blocked suffix, the same Error in the pending operation and end notice, later Error identity and actual peer closure before fixture cleanup.

## Verification and profile limits

After correcting one shared test to the portable codec's current reason-code profile, the pre-fix replay failed 21 of 38 cases. The initial run had one additional fixture failure because browser reason 0x8e is outside that profile. The shared compact control uses 0x82, while native 0x8e remains tested. The portable codec's reason/property profile is unchanged.

The final file has 41 cases. They cover every split, long Remaining/Property Length, Unicode controls, compact forms, native end-notice behavior and forbidden server properties. Additional truncation cases require the local DISCONNECT framing Error rather than fallback parser errors.

The first local-bounds mutation survived because the retained parser still rejected the selected truncated frames. The explicit framing-error cases detect that mutation. All six source faults are restored after verification.

DisconnectPropertyLayout checks validation before reason interpretation and preservation of compact forms for body sizes 0, 1 and 2. The shared reader model covers bounded nonpayload properties. These finite checks assume byte classification and do not prove UTF-8, the property table, concrete arithmetic, full reason-code legality or physical cleanup. Concrete vectors and public tests cover the stated byte, identity and cleanup behavior.

The [cardinality and scalar checks](property-cardinality-values.md) reject duplicate singleton properties and invalid values. Wider portable DISCONNECT reason support remains a profile question under #16/#19. No public QoS 2 capability, redirects or authentication behavior is added here.

Run:

    pnpm exec vitest run test/disconnect-property-strings.test.ts

Allocation and throughput costs remain unmeasured under #18 and #118.

[Packed observations](baseline/disconnect-property-checks.md) record each integration timing value and its limits.
