------------------------ MODULE SessionPresentAgreement ------------------------
CONSTANT Fault
VARIABLES phase, cause, presentObserved, refusedPresent, delivered
vars == <<phase, cause, presentObserved, refusedPresent, delivered>>
Init == /\ phase = "opening" /\ cause = "none" /\ presentObserved = FALSE
        /\ refusedPresent = FALSE /\ delivered = FALSE
Receive(present, refused) ==
  /\ phase = "opening"
  /\ LET protocol == present /\ Fault # "guard" /\ ~(refused /\ Fault = "refusal")
     IN /\ phase' = IF protocol \/ refused THEN "failed" ELSE "accepted"
        /\ cause' = IF protocol THEN "protocol" ELSE IF refused THEN "refusal" ELSE "none"
  /\ presentObserved' = present /\ refusedPresent' = (present /\ refused)
  /\ UNCHANGED delivered
LaterPresent ==
  /\ phase \in {"accepted", "active"}
  /\ presentObserved' = TRUE
  /\ phase' = IF Fault = "openingOnly" THEN phase ELSE "failed"
  /\ cause' = IF Fault = "openingOnly" THEN cause ELSE "protocol"
  /\ UNCHANGED <<refusedPresent, delivered>>
Activate == /\ phase = "accepted" /\ phase' = "active"
            /\ UNCHANGED <<cause, presentObserved, refusedPresent, delivered>>
Deliver == /\ phase = "active" /\ ~delivered /\ delivered' = TRUE
           /\ UNCHANGED <<phase, cause, presentObserved, refusedPresent>>
Next == (\E present, refused \in BOOLEAN: Receive(present, refused)) \/ LaterPresent \/ Activate \/ Deliver
Spec == Init /\ [][Next]_vars
PresentRetires == presentObserved => phase = "failed"
RefusedPresentIsProtocol == refusedPresent => cause = "protocol"
=============================================================================
