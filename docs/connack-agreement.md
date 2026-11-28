# Authentication and assigned identity agreement

The supported client factories send CONNECT without an Authentication Method. The shared session rejects unsolicited AUTH packets and CONNACK Authentication Method or Authentication Data properties. Presence matters, including an empty method or empty binary data. Enhanced authentication remains unsupported.

The session checks these fields synchronously before marking CONNACK accepted. This prevents a coalesced publication or acknowledgment from using an invalid opening attempt. An active unsolicited AUTH retires pending work through the existing first-error path. A protocol DISCONNECT notice uses the existing bounded reporting policy. The browser codec continues to reject unsupported authentication packets and properties during decoding, so its error text and classification can differ.

The session also validates Receive Maximum and Maximum QoS before acceptance. A QoS 0 PUBLISH that follows accepted CONNACK can reach `onMessage` before `connect()` resolves. Receipt of CONNACK establishes broker acceptance even if the local CONNECT write promise is still settling. A later failure can still reject `connect()` and stop subsequent delivery. If the CONNECT write rejects, the byte core stops input as soon as it observes the rejection. QoS 1 still waits for activation. [#149](https://github.com/dvkam/mqtt/issues/149)

[MQTT 5 section 4.12](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html) forbids server AUTH and CONNACK Authentication Method when CONNECT omitted the method. Authentication Data has no agreed interpretation in this profile and is rejected too. This change does not add an authentication exchange or method-selection interface.

## Assigned identity

A successful connection with an empty requested client ID requires a nonempty Assigned Client Identifier. The session rejects NUL, unpaired surrogates and strings exceeding 65,535 UTF-8 bytes, including at custom decoded transports. These checks preserve valid surrogate pairs and U+FEFF.

For a named client, the preview accepts an identical redundant Assigned Client Identifier and rejects a changed or empty identity. This is an identity-consistency policy. The specification describes assignment for empty requested IDs but does not explicitly prohibit an identical redundant assignment for a named client.

The constructor captures the requested client ID before listener registration. Both CONNECT and agreement checks use that snapshot. Mutating caller options during registration or after send cannot change it. Validation consumes reply metadata synchronously, without retaining mutable authentication or assignment fields for later acceptance.

Refused CONNACK packets do not require an assigned identifier. Their existing refusal reason remains the result when assignment is absent. Authentication violations are checked before refusal handling when authentication fields are present. A later AUTH or transport close cannot replace an earlier terminal error.

The portable codec reads and writes Assigned Client Identifier in CONNACK, rejects duplicate or misplaced occurrences, and forwards it through the browser adapter. The accepted identifier is available as `session.connection.clientId`. Sessions use Clean Start true unless the caller sets `cleanStart: false`, and a [reconnecting client](reconnect.md#resuming-the-session) with `resume` sends Clean Start false after its first session. Durable identity storage is tracked separately. [Connection metadata](public-types.md#broker-acknowledgment-results)

## Session Present and a second CONNACK

- A CONNACK with Session Present true after Clean Start true is a protocol error with reason code 0x82, and `connect()` rejects. After Clean Start false the client accepts either value. [Resuming the session](reconnect.md#resuming-the-session)
- A second CONNACK on the same connection is a protocol error with reason code 0x82, even when it repeats the first. It ends the session, or rejects `connect()` when `connect()` has not resolved yet. The client checks for it before it reads the Session Present flag, the authentication properties or the Assigned Client Identifier.

## Verification

The original agreement work ended with 54 cases. It covered every split in the portable codec, custom decoded transports, caller-option mutation, refusal ownership, coalesced success followed by AUTH, and native transport cleanup. The #149 cases exercise back-to-back QoS 0 delivery, refusal, and a CONNECT write failure after an accepted prefix. Public adapter tests also check peer closure and abort-listener removal before fixture cleanup.

ConnackAgreement explores empty and named requested IDs, caller-option mutation, method/data presence, four assignment classes, refusal, acceptance, activation and unsolicited AUTH. Its Deliver transition represents QoS 0 from acceptance onward. Its checks cover the captured wire identity, validation before acceptance and retirement on unsolicited AUTH. String validity is abstracted. The refusal transition represents a refusal without authentication properties. Exact Error identity, UTF-8 arithmetic, negotiated numeric bounds, native closure and server uniqueness remain outside this finite model.

SessionPresentAgreement assumes Clean Start true, and `test/session-resume.test.ts` covers both Session Present values after Clean Start false.

The baseline replay passed 39 configurations and detected 137 expected faults. The updated replay passes 40 and detects 143. Eight actual source faults remove method rejection, data rejection, AUTH rejection, the missing-assignment check, identity replacement rejection, the wire-ID snapshot, browser assignment forwarding or codec duplicate rejection. Each fails a regression and was restored.

Run `pnpm exec vitest run test/connack-agreement.test.ts test/portable.test.ts`. The project-local verification skill records the source mapping, complete replay and deliberate fault checks. Broader negotiated MQTT behavior remains under #16, enhanced-auth profile decisions under #19, and codec comparison under #9/#111.
