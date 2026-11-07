---------------------------- MODULE StreamTerminal ----------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, queued, pulling, result, terminal, accepted, delivered
vars == <<phase, queued, pulling, result, terminal, accepted, delivered>>
Init == /\ phase = "open" /\ queued = FALSE /\ pulling = FALSE /\ result = "none"
        /\ terminal = FALSE /\ accepted = FALSE /\ delivered = FALSE
Offer == /\ phase = "open" /\ ~accepted /\ accepted' = TRUE
         /\ IF pulling THEN /\ result' = "message" /\ UNCHANGED queued
                       ELSE /\ queued' = TRUE /\ UNCHANGED result
         /\ UNCHANGED <<phase, pulling, terminal, delivered>>
Pull == /\ ~terminal /\ ~pulling /\ pulling' = TRUE
        /\ result' = IF queued THEN "message" ELSE IF phase = "closing" THEN "end" ELSE "none"
        /\ queued' = FALSE
        /\ UNCHANGED <<phase, terminal, accepted, delivered>>
Resume == /\ pulling /\ result # "none"
          /\ delivered' = (delivered \/ (result = "message" /\ ~terminal))
          /\ terminal' = (terminal \/ result = "end" \/ (phase = "closing" /\ ~queued))
          /\ pulling' = FALSE /\ result' = "none"
          /\ UNCHANGED <<phase, queued, accepted>>
Close == /\ phase = "open" /\ phase' = "closing"
         /\ terminal' = (terminal \/ (~queued /\ (~pulling \/ Fault = "handoff") /\ Fault # "idle-close"))
         /\ result' = IF pulling /\ result = "none" THEN "end" ELSE result
         /\ UNCHANGED <<queued, pulling, accepted, delivered>>
Fail == /\ phase = "open" /\ phase' = "failed" /\ queued' = FALSE
        /\ terminal' = (Fault # "idle-fail")
        /\ result' = IF pulling THEN "end" ELSE result
        /\ UNCHANGED <<pulling, accepted, delivered>>
Cancel == /\ phase \in {"open", "closing"} /\ phase' = "cancelled"
          /\ queued' = FALSE /\ terminal' = TRUE
          /\ result' = IF pulling THEN "end" ELSE result
          /\ UNCHANGED <<pulling, accepted, delivered>>
Next == Offer \/ Pull \/ Resume \/ Close \/ Fail \/ Cancel
Spec == Init /\ [][Next]_vars
EmptyCompletion == (phase = "closing" /\ ~queued /\ ~pulling) => terminal
FailureSettles == phase = "failed" => terminal
PreserveHandedMessage == (phase = "closing" /\ result = "message" /\ ~delivered) => ~terminal
=============================================================================
