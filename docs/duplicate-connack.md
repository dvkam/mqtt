# Duplicate CONNACK rejection

The shared session accepts at most one decoded CONNACK per network connection. It records the first receipt before reading metadata or invoking the pending acknowledgment handler. Every later decoded CONNACK retires the connection with protocol error 0x82.

[MQTT 5 section 3.2](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html) prohibits the server from sending more than one CONNACK on a connection. The receipt rule applies to an identical packet, changed capabilities and a later refusal. Earlier terminal errors retain ownership, including a first refusal or invalid first CONNACK.

## Placement and ownership

The private receipt flag belongs to one PortableClient instance. It never resets during that instance's lifetime. It is independent of activation and pending acknowledgments. A custom transport can deliver a packet during listener registration, before an exchange exists; that complete receipt still counts. Two independent clients each accept their own first CONNACK.

A duplicate during accepted opening rejects the connection before handoff, including when CONNECT send is still pending and a QoS 1 message is queued. An active duplicate rejects pending work, preserves an already delivered application prefix and blocks later packets. Existing bounded DISCONNECT reporting and forced-close ownership remain unchanged.

Duplicate detection precedes Session Present, authentication and assigned-identity checks in the shared session. A second decoded CONNACK therefore reports the duplicate even if it also has contradictory metadata. Earlier decoders still own malformed wire input. Their existing errors can occur before the second CONNACK reaches this receipt check.

The standalone codecs retain no connection history. They continue decoding repeated valid CONNACK frames independently. This change adds no reconnect, resume or transport abstraction.

## Verification

The first 16-case set failed 12 cases on the old source. Replaying the final 19 cases on the old source fails 15. The file includes WebSocket delivery with one byte per message and a custom metadata getter that reenters delivery. All 19 pass with the guard. Tests cover registration-time receipts, a held CONNECT send, mutable packet replay, earlier terminal causes, independent clients and public opening/active behavior. Public adapter tests assert exact later-operation and session-end Error identity, real peer closure and abort-listener removal before fixture cleanup.

DuplicateConnack explores eight states with up to two receipts across registered, waiting, accepted, active and failed phases. SecondReceiptRetires checks that the second usable receipt retires specifically as a duplicate. The model records receipt independently of activation. It assumes complete decoded packets with valid plain metadata and excludes accessor reentry, byte framing, payload ownership, exact Error identity, timing and physical closure. The getter regression separately checks receipt recording before metadata access.

SessionPresentAgreement retains its eight positive states and safety invariants. Its later-CONNACK transition now maps to duplicate rejection. The former opening-only Session Present fault is obsolete because the earlier receipt check independently rejects every later CONNACK. That negative configuration is retired rather than counted as a live source defect. The new receipt guard, delayed-recording and active-only faults cover the current control flow. No previous safety property or bound is weakened.

Five deliberate source faults omit duplicate rejection, record receipt only while an acknowledgment handler exists, restrict rejection to active sessions, start with an already-consumed flag or move recording after metadata access. Each fails a regression and was restored. Applying the retired opening-only Session Present mutation now passes all 19 Session Present tests, which confirms that the earlier duplicate guard masks it.

The authentication and assigned-ID model remains scoped to first receipts with Session Present false. These finite projections do not establish exhaustive composition or full MQTT conformance. Run `pnpm exec vitest run test/duplicate-connack.test.ts test/session-present.test.ts`. Wider validation remains under #9; session restoration remains under #12/#16.

The unchanged baseline passes 41 configurations and detects 146 expected faults. The final replay passes 42 configurations and detects 148 expected faults, with three added fault cases and one retired obsolete case.

The [packed observations](baseline/duplicate-connack-checks.md) preserve individual broker smoke values, their limits and the known native direct-WSS outcome. They establish no performance advantage.
