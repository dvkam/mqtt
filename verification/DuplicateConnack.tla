---------------------------- MODULE DuplicateConnack ----------------------------
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
