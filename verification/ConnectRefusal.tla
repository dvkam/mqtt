----------------------------- MODULE ConnectRefusal -----------------------------
CONSTANT Fault
VARIABLES phase, reason, firstReason, refusalSeen, queued
vars == <<phase, reason, firstReason, refusalSeen, queued>>
Init == /\ phase = "waiting" /\ reason = "none" /\ firstReason = "none"
        /\ refusalSeen = FALSE /\ queued = FALSE
Refuse == /\ phase = "waiting" /\ ~refusalSeen /\ refusalSeen' = TRUE
          /\ firstReason' = "refusal" /\ queued' = (Fault = "defer")
          /\ phase' = IF Fault = "defer" THEN "waiting" ELSE "failed"
          /\ reason' = IF Fault = "defer" THEN "none" ELSE "refusal"
ProcessQueued == /\ phase = "waiting" /\ queued /\ phase' = "failed"
                 /\ reason' = "refusal" /\ queued' = FALSE
                 /\ UNCHANGED <<firstReason, refusalSeen>>
Accept == /\ phase = "waiting" /\ ~refusalSeen /\ phase' = "active"
          /\ UNCHANGED <<reason, firstReason, refusalSeen, queued>>
Close == /\ phase # "failed" /\ phase' = "failed" /\ reason' = "transport"
         /\ firstReason' = IF firstReason = "none" THEN "transport" ELSE firstReason
         /\ UNCHANGED <<refusalSeen, queued>>
RepeatClose == /\ phase = "failed" /\ Fault = "overwrite" /\ reason' = "later transport"
               /\ UNCHANGED <<phase, firstReason, refusalSeen, queued>>
Next == Refuse \/ ProcessQueued \/ Accept \/ Close \/ RepeatClose
Spec == Init /\ [][Next]_vars
FirstTerminalReason == phase = "failed" => reason = firstReason
=============================================================================
