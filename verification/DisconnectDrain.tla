---------------------------- MODULE DisconnectDrain ---------------------------
\* Rule: disconnect() accepts no new publication. It writes DISCONNECT only after the active QoS 1 exchange settled
\* or the drain deadline expired. At the deadline a publication keeps the outcome of a PUBACK that already arrived.
\* Source: src/portable.ts (disconnect, end, publish, fail)
\* Source: src/outboundQosOne.ts (OutboundQosOne, stop, waitForActive, finishActive, accept)
\* Tests: test/qos1-publish.test.ts
\* Mapping: Send is publish. Start is disconnect setting closing and calling stop. ObserveAck is accept recording
\* the reason code. Settle is the exchange completing. Expire is the timer in waitForActive, which calls
\* finishActive and keeps recorded acknowledgments. Disconnect is end writing DISCONNECT. Fail is fail calling
\* retire.
\* Not modeled: More than one publication, the resends that stop drops, keep alive during the drain, and QoS 0
\* writes.
CONSTANT Fault
VARIABLES phase, publication, brokerOutcome, expired, sentAfterStop, disconnectSent
vars == <<phase, publication, brokerOutcome, expired, sentAfterStop, disconnectSent>>

Init == /\ phase = "active" /\ publication = "none" /\ brokerOutcome = "missing"
        /\ expired = FALSE /\ sentAfterStop = FALSE /\ disconnectSent = FALSE

Send == /\ publication = "none"
        /\ (phase = "active" \/ (Fault = "lateSend" /\ phase = "draining"))
        /\ publication' = "pending" /\ sentAfterStop' = (phase # "active")
        /\ UNCHANGED <<phase, brokerOutcome, expired, disconnectSent>>

Start == /\ phase = "active" /\ phase' = "draining"
         /\ UNCHANGED <<publication, brokerOutcome, expired, sentAfterStop, disconnectSent>>

ObserveAck == /\ phase \in {"active", "draining"} /\ publication = "pending" /\ brokerOutcome = "missing"
              /\ brokerOutcome' \in {"acknowledged", "refused"}
              /\ UNCHANGED <<phase, publication, expired, sentAfterStop, disconnectSent>>

Settle == /\ phase \in {"active", "draining"} /\ publication = "pending" /\ brokerOutcome # "missing"
          /\ publication' = brokerOutcome
          /\ UNCHANGED <<phase, brokerOutcome, expired, sentAfterStop, disconnectSent>>

OutcomeAtDeadline == IF brokerOutcome = "missing" THEN "unknown" ELSE brokerOutcome

Expire == /\ phase = "draining" /\ publication = "pending"
          /\ expired' = TRUE /\ publication' = IF Fault = "closedOutcome" THEN "closed" ELSE OutcomeAtDeadline
          /\ UNCHANGED <<phase, brokerOutcome, sentAfterStop, disconnectSent>>

Disconnect == /\ phase = "draining" /\ (publication # "pending" \/ Fault = "earlyDisconnect")
              /\ phase' = "disconnecting" /\ disconnectSent' = TRUE
              /\ UNCHANGED <<publication, brokerOutcome, expired, sentAfterStop>>

Finish == /\ phase = "disconnecting" /\ phase' = "retired"
          /\ UNCHANGED <<publication, brokerOutcome, expired, sentAfterStop, disconnectSent>>

Fail == /\ phase \in {"active", "draining"} /\ phase' = "retired"
        /\ publication' = IF publication = "pending" THEN "closed" ELSE publication
        /\ UNCHANGED <<brokerOutcome, expired, sentAfterStop, disconnectSent>>

Next == Send \/ Start \/ ObserveAck \/ Settle \/ Expire \/ Disconnect \/ Finish \/ Fail
Spec == Init /\ [][Next]_vars
NoSendAfterStop == ~sentAfterStop
DrainBeforeDisconnect == disconnectSent => publication # "pending"
DeadlinePreservesOutcome == expired => publication = OutcomeAtDeadline
=============================================================================
