-------------------------- MODULE NodeCanonicalLength --------------------------
\* Rule: The framer rejects a Remaining Length with a fifth byte, or with a zero last byte after a continuation
\* byte, before it admits the packet.
\* Source: src/packetFramer.ts (PacketFramer, push)
\* Tests: test/tcp-packet-admission.test.ts, test/bounded-node-decoder.test.ts, test/browser-core-changes.test.ts
\* Mapping: Continuation is a length byte with bit 7 set. Terminator is the last length byte, and zero says that its
\* value is 0. Phase "admitted" is the size check and the allocation that follow.
\* Not modeled: The length value and maxPacketBytes, which NodePacketAdmission covers.
EXTENDS Naturals
CONSTANT Fault
VARIABLES continued, phase, nonminimal
vars == <<continued, phase, nonminimal>>

Init == /\ continued = 0 /\ phase = "length" /\ nonminimal = FALSE

Continuation ==
  /\ phase = "length"
  /\ IF continued = 3
     THEN /\ phase' = "rejected" /\ UNCHANGED continued
     ELSE /\ phase' = "length" /\ continued' = continued + 1
  /\ UNCHANGED nonminimal

Terminator(zero) ==
  /\ phase = "length"
  /\ nonminimal' = (continued > 0 /\ zero)
  /\ phase' = IF nonminimal' /\ Fault # "skip" THEN "rejected" ELSE "admitted"
  /\ UNCHANGED continued

Next == Continuation \/ (\E zero \in BOOLEAN: Terminator(zero))
Spec == Init /\ [][Next]_vars

CanonicalBeforeAdmission == phase = "admitted" => ~nonminimal
===============================================================================
