# Session Present and Clean Start

The supported factories always send CONNECT with Clean Start true. They hold no prior broker session state. A CONNACK with Session Present true contradicts that request, so the shared session rejects it synchronously before acceptance with protocol error 0x82.

[MQTT 5 section 3.2.2.1](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html) requires Session Present false when the server accepts Clean Start true. It also requires a client without prior session state to close when Session Present is true. Refused CONNACK packets must have Session Present false as well.

The guard runs before authentication, assigned-identity validation and pending acknowledgment handling. It covers custom decoded transports, which can bypass wire checks. A valid refusal with Session Present false keeps its refusal reason. A later contradictory CONNACK or transport close cannot replace an earlier terminal cause.

The same guard runs if a contradictory CONNACK arrives after an earlier acceptance. It retires accepted opening work before queued QoS 1 delivery. Existing protocol-notice policy remains unchanged: before acceptance the client closes without a DISCONNECT notice; accepted or active sessions use the existing bounded notice attempt.

## Codec scope

The standalone portable codec still encodes and decodes successful CONNACK packets with Session Present true. It has no CONNECT context, and callers outside the supported factories can request Clean Start false. Its existing rejection of refused CONNACK plus Session Present true remains unchanged. The browser adapter may therefore reject that malformed refusal during decoding rather than produce the shared session's error text.

This change adds no resume option, persistence store, reconnect policy or local session restoration. Future support for Clean Start false must change the CONNECT request, agreement checks, tests and verification together. Valid Session Present false remains accepted by the current profile.

## Evidence

The first regression set failed 6 of 12 cases on the old source. The expanded set failed 10 of 16 after adding accepted-opening cases. Review added three active-session tests. Replaying the final 19 cases on the old source fails 13, while all 19 pass with the guard. Tests cover successful and refused custom packets, valid false controls, earlier refusal ownership, exact session-end Error identity, coalesced suffix suppression and real peer closure with abort-listener removal. The custom accepted-opening test queues QoS 1 before the contradictory packet while the CONNECT send is still pending. Active-session cases reject a pending ping before its trailing PINGRESP and publication.

SessionPresentAgreement checks eight states for opening, accepted, active and failed phases, the Session Present flag and success/refusal classification. PresentRetires checks synchronous retirement after the contradiction. RefusedPresentIsProtocol distinguishes a malformed refusal from an ordinary refused connection. The original verification included faults that omitted the guard, preserved ordinary refusal classification or limited checks to opening. The later-CONNACK transition now maps to the earlier duplicate-receipt guard, so the opening-only fault is retired. First-receipt guard and refusal faults remain active.

The finite model assumes Clean Start true and no prior session state. It classifies complete CONNACK packets and excludes byte framing, exact Error identity, notice timing and physical closure. The existing authentication and assigned-ID model retains its previous scope for Session Present false. Concrete wire and custom-transport tests cover the stated classifications and cleanup.

At the original source revision, the baseline replay passed 40 configurations and detected 143 expected faults. That update passed 41 and detected 146. Four source faults removed the guard, skipped refused packets, limited the guard to opening or changed CONNECT to Clean Start false. Each failed a regression and was restored at that revision. The [duplicate-receipt update](duplicate-connack.md) records the current totals and retirement of the now-masked opening-only fault. The models retain their previous bounds; these separate finite checks are not an exhaustive proof of their composition.

Run `pnpm exec vitest run test/session-present.test.ts`. Wider packet validation remains under #9 and negotiated/reconnect behavior under #16/#12. The [receipt check](duplicate-connack.md) now rejects later decoded CONNACK packets before their metadata checks. Repeated Session Present tests retain protocol code 0x82 and now expect the duplicate classification.

The [packed observations](baseline/session-present-checks.md) record the valid broker controls, individual timings and known native direct-WSS limitation. They establish no performance advantage.
