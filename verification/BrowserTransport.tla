----------------------------- MODULE BrowserTransport -----------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLES retired, captured, queued, invalidDelivery, nativeClosed, settled, observerThrows
vars == <<retired, captured, queued, invalidDelivery, nativeClosed, settled, observerThrows>>
Init == /\ retired = FALSE
        /\ captured = FALSE
        /\ queued = 0
        /\ invalidDelivery = FALSE
        /\ nativeClosed = FALSE
        /\ settled = FALSE
        /\ observerThrows \in BOOLEAN
Capture == /\ ~retired /\ ~captured
           /\ captured' = TRUE
           /\ UNCHANGED <<retired, queued, invalidDelivery, nativeClosed, settled, observerThrows>>
Deliver == /\ captured
           /\ invalidDelivery' = (invalidDelivery \/ (retired /\ Fault = "delivery"))
           /\ captured' = FALSE
           /\ UNCHANGED <<retired, queued, nativeClosed, settled, observerThrows>>
Admit == /\ ~retired
         /\ queued < 3
         /\ (queued < 2 \/ Fault = "budget")
         /\ queued' = queued + 1
         /\ UNCHANGED <<retired, captured, invalidDelivery, nativeClosed, settled, observerThrows>>
Drain == /\ queued > 0 /\ queued' = queued - 1
         /\ UNCHANGED <<retired, captured, invalidDelivery, nativeClosed, settled, observerThrows>>
Retire == /\ ~retired /\ retired' = TRUE
          /\ UNCHANGED <<captured, queued, invalidDelivery, nativeClosed, settled, observerThrows>>
NativeClose == /\ ~nativeClosed
               /\ nativeClosed' = TRUE
               /\ retired' = TRUE
               /\ settled' = ~(observerThrows /\ Fault = "observer")
               /\ UNCHANGED <<captured, queued, invalidDelivery, observerThrows>>
Deadline == /\ retired /\ ~settled
            /\ settled' = TRUE
            /\ UNCHANGED <<retired, captured, queued, invalidDelivery, nativeClosed, observerThrows>>
Next == Capture \/ Deliver \/ Admit \/ Drain \/ Retire \/ NativeClose \/ Deadline
Spec == Init /\ [][Next]_vars
NoLateDelivery == ~invalidDelivery
BoundedAdmission == queued <= 2
NativeCloseSettles == nativeClosed => settled
=============================================================================
