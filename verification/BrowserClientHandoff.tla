----------------------------- MODULE BrowserClientHandoff -----------------------------
CONSTANT Fault
VARIABLES phase, aborted, badTransfer, forcing, forceSettled
vars == <<phase, aborted, badTransfer, forcing, forceSettled>>
Init == /\ phase = "connecting" /\ aborted = FALSE
        /\ badTransfer = FALSE /\ forcing = FALSE /\ forceSettled = FALSE
CoreReady == /\ phase = "connecting" /\ ~aborted
             /\ phase' = "handoff"
             /\ UNCHANGED <<aborted, badTransfer, forcing, forceSettled>>
Cancel == /\ ~aborted /\ aborted' = TRUE
          /\ phase' = IF phase = "active" THEN "retired" ELSE phase
          /\ UNCHANGED <<badTransfer, forcing, forceSettled>>
Transfer == /\ phase = "handoff"
            /\ phase' = IF aborted /\ Fault # "handoff" THEN "retired" ELSE "active"
            /\ badTransfer' = (badTransfer \/ (aborted /\ Fault = "handoff"))
            /\ UNCHANGED <<aborted, forcing, forceSettled>>
Force == /\ phase \in {"handoff", "active"} /\ ~forcing
         /\ phase' = "retired" /\ forcing' = TRUE
         /\ forceSettled' = (Fault # "force")
         /\ UNCHANGED <<aborted, badTransfer>>
NativeClose == /\ forcing /\ ~forceSettled
               /\ forceSettled' = TRUE
               /\ UNCHANGED <<phase, aborted, badTransfer, forcing>>
Next == CoreReady \/ Cancel \/ Transfer \/ Force \/ NativeClose
Spec == Init /\ [][Next]_vars
NoCancelledTransfer == ~badTransfer
ForceWithoutNativeWait == forcing => forceSettled
=============================================================================
