----------------------------- MODULE TimeoutAdmission -----------------------------
CONSTANT Fault
VARIABLES phase, configured, accepted, used, acquired
vars == <<phase, configured, accepted, used, acquired>>
Init == /\ phase = "new" /\ configured \in {"valid", "invalid"}
        /\ accepted = "none" /\ used = "none" /\ acquired = FALSE
Configure == /\ phase = "new"
             /\ phase' = IF configured = "valid" \/ Fault = "validation" THEN "active" ELSE "rejected"
             /\ acquired' = (configured = "valid" \/ Fault = "validation")
             /\ accepted' = configured
             /\ UNCHANGED <<configured, used>>
Mutate == /\ phase = "active" /\ configured = "valid" /\ configured' = "invalid"
          /\ UNCHANGED <<phase, accepted, used, acquired>>
Operate == /\ phase = "active" /\ used = "none"
           /\ used' = IF Fault = "snapshot" THEN configured ELSE accepted
           /\ UNCHANGED <<phase, configured, accepted, acquired>>
Next == Configure \/ Mutate \/ Operate
Spec == Init /\ [][Next]_vars
ValidateBeforeAcquire == acquired => accepted = "valid"
RetainAcceptedDeadline == used # "none" => used = accepted
=============================================================================
