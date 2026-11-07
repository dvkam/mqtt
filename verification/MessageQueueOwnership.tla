------------------------ MODULE MessageQueueOwnership ------------------------
EXTENDS Naturals, Sequences
CONSTANT Fault
VARIABLES phase, entries, bytes, waiting, lateDelivery, protocolAlive, control
vars == <<phase, entries, bytes, waiting, lateDelivery, protocolAlive, control>>
Init == /\ phase = "open" /\ entries = <<>> /\ bytes = 0 /\ waiting = 0
        /\ lateDelivery = FALSE /\ protocolAlive = TRUE /\ control = 0
Offer(size) == /\ (phase = "open" \/ Fault = "late")
               /\ IF (Len(entries) = 2 \/ size > 3 - bytes) /\ Fault # "budget"
                  THEN /\ phase' = "failed" /\ entries' = <<>> /\ bytes' = 0 /\ waiting' = 0
                       /\ UNCHANGED lateDelivery
                  ELSE /\ UNCHANGED phase
                       /\ IF waiting > 0
                          THEN /\ waiting' = 0 /\ UNCHANGED <<entries, bytes>>
                          ELSE /\ entries' = Append(entries, size) /\ bytes' = bytes + size
                               /\ UNCHANGED waiting
                       /\ lateDelivery' = (lateDelivery \/ phase # "open")
               /\ UNCHANGED <<protocolAlive, control>>
Read == /\ phase \in {"open", "closing"} /\ Len(entries) > 0
        /\ bytes' = bytes - Head(entries) /\ entries' = Tail(entries)
        /\ UNCHANGED <<phase, waiting, lateDelivery, protocolAlive, control>>
Wait == /\ phase = "open" /\ Len(entries) = 0
        /\ (waiting = 0 \/ (Fault = "waiter" /\ waiting = 1))
        /\ waiting' = waiting + 1
        /\ UNCHANGED <<phase, entries, bytes, lateDelivery, protocolAlive, control>>
Close == /\ phase = "open" /\ phase' = "closing" /\ waiting' = 0
         /\ UNCHANGED <<entries, bytes, lateDelivery, protocolAlive, control>>
Stop == /\ phase \in {"open", "closing"} /\ phase' = "stopped"
        /\ entries' = <<>> /\ bytes' = 0 /\ waiting' = 0
        /\ protocolAlive' = (Fault # "cancel")
        /\ UNCHANGED <<lateDelivery, control>>
Fail == /\ phase = "open" /\ phase' = "failed"
        /\ entries' = <<>> /\ bytes' = 0 /\ waiting' = 0
        /\ UNCHANGED <<lateDelivery, protocolAlive, control>>
Control == /\ protocolAlive /\ control < 2 /\ control' = control + 1
           /\ UNCHANGED <<phase, entries, bytes, waiting, lateDelivery, protocolAlive>>
Next == (\E size \in 1..4: Offer(size)) \/ Read \/ Wait \/ Close \/ Stop \/ Fail \/ Control
Spec == Init /\ [][Next]_vars
BoundedQueue == Len(entries) <= 2 /\ bytes <= 3
NoLateDelivery == ~lateDelivery
ConsumerDoesNotOwnProtocol == protocolAlive
BoundedWaiters == waiting <= 1
=============================================================================
