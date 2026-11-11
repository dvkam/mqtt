----------------------- MODULE NodeConnackProperties -----------------------
EXTENDS Naturals
CONSTANT Fault, HasPayload
VARIABLES phase, shape, cursor, propertyEnd, frameEnd, reads, delivered
vars == <<phase, shape, cursor, propertyEnd, frameEnd, reads, delivered>>

Init == /\ phase = "walking"
        /\ shape \in {"valid", "badUtf8", "nul", "truncated", "badIdentifier", "noncanonical"}
        /\ cursor = 0
        /\ propertyEnd = IF shape = "truncated" THEN 1 ELSE 2
        /\ frameEnd = IF HasPayload THEN propertyEnd + 1 ELSE propertyEnd
        /\ reads = 0
        /\ delivered = FALSE

Read == /\ phase = "walking" /\ reads < 2
        /\ IF cursor + 1 <= propertyEnd \/ Fault = "bounds"
              \/ (Fault = "payload" /\ cursor + 1 <= frameEnd)
              THEN /\ cursor' = cursor + 1 /\ reads' = reads + 1 /\ phase' = phase
              ELSE /\ phase' = "failed" /\ UNCHANGED <<cursor, reads>>
        /\ UNCHANGED <<shape, propertyEnd, frameEnd, delivered>>

Accepted == shape = "valid"
            \/ (Fault = "string" /\ shape \in {"badUtf8", "nul"})
            \/ (Fault = "bounds" /\ shape = "truncated")
            \/ (Fault = "identifier" /\ shape = "badIdentifier")
            \/ (Fault = "canonical" /\ shape = "noncanonical")

Complete == /\ phase = "walking" /\ reads = 2
            /\ phase' = IF Accepted THEN "ready" ELSE "failed"
            /\ UNCHANGED <<shape, cursor, propertyEnd, frameEnd, reads, delivered>>

Dispatch == /\ phase = "ready"
            /\ phase' = "dispatched"
            /\ delivered' = TRUE
            /\ UNCHANGED <<shape, cursor, propertyEnd, frameEnd, reads>>

Next == Read \/ Complete \/ Dispatch
Spec == Init /\ [][Next]_vars
BoundedCursor == cursor <= propertyEnd
ValidateBeforeDelivery == delivered => shape = "valid"
=============================================================================
