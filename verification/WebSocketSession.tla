----------------------------- MODULE WebSocketSession -----------------------------
EXTENDS Naturals

CONSTANT Fault
VARIABLES phase, queued, invalidDelivery
vars == <<phase, queued, invalidDelivery>>

Init == /\ phase = "awaiting"
        /\ queued = 0
        /\ invalidDelivery = FALSE

Accept == /\ phase = "awaiting"
          /\ phase' = "active"
          /\ UNCHANGED <<queued, invalidDelivery>>

Deliver == /\ (phase = "active" \/ Fault = "deliver")
           /\ invalidDelivery' = (invalidDelivery \/ phase # "active")
           /\ UNCHANGED <<phase, queued>>

Admit == /\ phase = "active"
         /\ (queued < 2 \/ Fault = "budget")
         /\ queued < 3
         /\ queued' = queued + 1
         /\ UNCHANGED <<phase, invalidDelivery>>

Drain == /\ queued > 0
         /\ queued' = queued - 1
         /\ UNCHANGED <<phase, invalidDelivery>>

Close == /\ phase # "closed"
         /\ phase' = "closed"
         /\ queued' = 0
         /\ UNCHANGED invalidDelivery

Next == Accept \/ Deliver \/ Admit \/ Drain \/ Close
Spec == Init /\ [][Next]_vars
NoInvalidDelivery == ~invalidDelivery
BoundedBudget == queued <= 2
=============================================================================
