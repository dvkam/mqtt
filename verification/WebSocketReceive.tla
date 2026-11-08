--------------------------- MODULE WebSocketReceive ---------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLES retired, capturedSize, excessAdmitted, lateAdmitted
vars == <<retired, capturedSize, excessAdmitted, lateAdmitted>>
Init == /\ retired = FALSE /\ capturedSize = 0
        /\ excessAdmitted = FALSE /\ lateAdmitted = FALSE
Capture == /\ ~retired /\ capturedSize = 0 /\ capturedSize' \in 1..3
           /\ UNCHANGED <<retired, excessAdmitted, lateAdmitted>>
Deliver == /\ capturedSize > 0
           /\ excessAdmitted' = (excessAdmitted \/ (~retired /\ capturedSize > 2 /\ Fault = "budget"))
           /\ lateAdmitted' = (lateAdmitted \/ (retired /\ capturedSize <= 2 /\ Fault = "late"))
           /\ retired' = (retired \/ (capturedSize > 2 /\ Fault # "budget"))
           /\ capturedSize' = 0
Retire == /\ ~retired /\ retired' = TRUE
          /\ UNCHANGED <<capturedSize, excessAdmitted, lateAdmitted>>
Next == Capture \/ Deliver \/ Retire
Spec == Init /\ [][Next]_vars
BoundedReceive == ~excessAdmitted
NoLateReceive == ~lateAdmitted
=============================================================================
