---------------------------- MODULE DuplicateConnack ----------------------------
\* Rule: The session records the first CONNACK in every phase, and a second CONNACK ends the session with a protocol
\* error.
\* Source: src/portable.ts (receiveConnack, connackReceived, rejectProtocolInput)
\* Tests: test/duplicate-connack.test.ts
\* Mapping: Send is open starting the CONNECT exchange. Receipt is receiveConnack, which tests and sets
\* connackReceived before every other check. Activate is open setting activation to active.
\* Not modeled: CONNACK contents other than a refusal, and the DISCONNECT notice, which ParserAckNotice covers.
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, seen, receipts, reason
vars == <<phase, seen, receipts, reason>>
Init == /\ phase = "registered" /\ seen = FALSE /\ receipts = 0 /\ reason = "none"
Send == /\ phase = "registered" /\ phase' = "waiting"
        /\ UNCHANGED <<seen, receipts, reason>>
Receipt(refused) ==
  /\ phase # "failed" /\ receipts < 2
  /\ LET duplicate == seen /\ Fault # "guard" /\ (Fault # "activeOnly" \/ phase = "active")
         matched == phase \in {"waiting", "accepted"}
     IN /\ phase' = IF duplicate THEN "failed"
                    ELSE IF matched THEN IF refused THEN "failed" ELSE "accepted" ELSE phase
        /\ reason' = IF duplicate THEN "duplicate"
                     ELSE IF matched /\ refused THEN "refusal" ELSE reason
  /\ seen' = IF Fault = "late" THEN seen \/ phase = "waiting" ELSE TRUE
  /\ receipts' = receipts + 1
Activate == /\ phase = "accepted" /\ phase' = "active"
            /\ UNCHANGED <<seen, receipts, reason>>
Next == Send \/ Activate \/ (\E refused \in BOOLEAN: Receipt(refused))
Spec == Init /\ [][Next]_vars
SecondReceiptRetires == receipts = 2 => phase = "failed" /\ reason = "duplicate"
=============================================================================
