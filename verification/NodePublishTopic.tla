----------------------------- MODULE NodePublishTopic -------------------------
CONSTANT Fault
VARIABLES phase, shape, delivered
vars == <<phase, shape, delivered>>

Init == /\ phase = "partial"
        /\ shape \in {"valid", "badUtf8", "nul", "truncated"}
        /\ delivered = FALSE

Complete == /\ phase = "partial"
            /\ phase' = IF shape = "valid" \/ Fault = "skip" THEN "ready" ELSE "failed"
            /\ UNCHANGED <<shape, delivered>>

Dispatch == /\ phase = "ready"
            /\ phase' = "dispatched" /\ delivered' = TRUE
            /\ UNCHANGED shape

Next == Complete \/ Dispatch
Spec == Init /\ [][Next]_vars
ValidateBeforeDelivery == delivered => shape = "valid"
===============================================================================
