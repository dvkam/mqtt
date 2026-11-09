------------------------------ MODULE QosOneOutbound ------------------------------
EXTENDS Naturals, FiniteSets, Sequences
CONSTANT Fault
VARIABLES phase, queue, cost, identifier, quota, dispatched, sent, acked,
          canceledQueued, canceledActive, stopped, atStop, retired, wrong
vars == <<phase, queue, cost, identifier, quota, dispatched, sent, acked,
          canceledQueued, canceledActive, stopped, atStop, retired, wrong>>
Jobs == {1, 2, 3}
Ids == {1, 2, 3}
SubscriptionId == 1
Queued == {job \in Jobs : phase[job] = "queued"}
Active == {job \in Jobs : phase[job] = "active"}
Held == {job \in Jobs : phase[job] \in {"queued", "active", "retired"}}
Bytes == (IF 1 \in Held THEN cost[1] ELSE 0)
       + (IF 2 \in Held THEN cost[2] ELSE 0)
       + (IF 3 \in Held THEN cost[3] ELSE 0)
Used == {SubscriptionId} \cup {identifier[job] : job \in Active}
Init == /\ phase = [job \in Jobs |-> "idle"] /\ queue = <<>>
        /\ cost = [job \in Jobs |-> 1] /\ identifier = [job \in Jobs |-> 0]
        /\ quota \in {1, 2}
        /\ dispatched = {} /\ sent = {} /\ acked = {}
        /\ canceledQueued = {} /\ canceledActive = {}
        /\ stopped = FALSE /\ atStop = {} /\ retired = FALSE /\ wrong = FALSE
Enqueue == \E job \in Jobs, charge \in {1, 3}:
  /\ ~stopped /\ phase[job] = "idle"
  /\ (Cardinality(Held) < 2 \/ Fault = "items")
  /\ (Bytes + charge <= 3 \/ Fault = "bytes")
  /\ phase' = [phase EXCEPT ![job] = "queued"]
  /\ queue' = Append(queue, job)
  /\ cost' = [cost EXCEPT ![job] = charge]
  /\ UNCHANGED <<identifier, quota, dispatched, sent, acked, canceledQueued, canceledActive, stopped, atStop, retired, wrong>>
Dispatch == /\ Len(queue) > 0 /\ (~stopped \/ Fault = "stop") /\ ~retired
            /\ (Cardinality(Active) < quota \/ Fault = "quota")
            /\ \E chosen \in Ids:
                 /\ (chosen \notin Used \/ Fault = "id")
                 /\ phase' = [phase EXCEPT ![Head(queue)] = "active"]
                 /\ identifier' = [identifier EXCEPT ![Head(queue)] = chosen]
                 /\ dispatched' = dispatched \cup {Head(queue)}
                 /\ queue' = Tail(queue)
            /\ UNCHANGED <<cost, quota, sent, acked, canceledQueued, canceledActive, stopped, atStop, retired, wrong>>
Send == \E job \in dispatched \ sent:
  /\ sent' = sent \cup {job}
  /\ UNCHANGED <<phase, queue, cost, identifier, quota, dispatched, acked, canceledQueued, canceledActive, stopped, atStop, retired, wrong>>
Ack == \E job \in Active \ acked, kind \in {"puback", "other"}, wireId \in Ids:
  /\ ((kind = "puback" /\ wireId = identifier[job]) \/ Fault = "ack")
  /\ acked' = acked \cup {job}
  /\ wrong' = (wrong \/ kind # "puback" \/ wireId # identifier[job])
  /\ UNCHANGED <<phase, queue, cost, identifier, quota, dispatched, sent, canceledQueued, canceledActive, stopped, atStop, retired>>
Complete == \E job \in Active \cap acked:
  /\ (job \in sent \/ Fault = "early")
  /\ phase' = [phase EXCEPT ![job] = "done"]
  /\ UNCHANGED <<queue, cost, identifier, quota, dispatched, sent, acked, canceledQueued, canceledActive, stopped, atStop, retired, wrong>>
CancelQueued == \E job \in Queued \ canceledQueued:
  /\ canceledQueued' = canceledQueued \cup {job}
  /\ queue' = IF Fault = "queuedAbort" THEN queue ELSE SelectSeq(queue, LAMBDA queuedJob : queuedJob # job)
  /\ phase' = IF Fault = "queuedAbort" THEN phase ELSE [phase EXCEPT ![job] = "done"]
  /\ UNCHANGED <<cost, identifier, quota, dispatched, sent, acked, canceledActive, stopped, atStop, retired, wrong>>
CancelActive == \E job \in Active \ canceledActive:
  /\ canceledActive' = canceledActive \cup {job}
  /\ phase' = IF Fault = "activeAbort" THEN [phase EXCEPT ![job] = "done"] ELSE phase
  /\ UNCHANGED <<queue, cost, identifier, quota, dispatched, sent, acked, canceledQueued, stopped, atStop, retired, wrong>>
Stop == /\ ~stopped /\ stopped' = TRUE /\ atStop' = dispatched
        /\ queue' = IF Fault = "stop" THEN queue ELSE <<>>
        /\ phase' = [job \in Jobs |-> IF job \in Queued /\ Fault # "stop" THEN "done" ELSE phase[job]]
        /\ UNCHANGED <<cost, identifier, quota, dispatched, sent, acked, canceledQueued, canceledActive, retired, wrong>>
Retire == /\ ~retired /\ retired' = TRUE /\ stopped' = TRUE /\ queue' = <<>>
          /\ atStop' = IF stopped THEN atStop ELSE dispatched
          /\ phase' = [job \in Jobs |-> CASE job \in Active -> IF Fault = "terminal" THEN "done" ELSE "retired"
                                           [] job \in Queued -> "done"
                                           [] OTHER -> phase[job]]
          /\ UNCHANGED <<cost, identifier, quota, dispatched, sent, acked, canceledQueued, canceledActive, wrong>>
ReleaseRetired == \E job \in sent:
  /\ phase[job] = "retired"
  /\ phase' = [phase EXCEPT ![job] = "done"]
  /\ UNCHANGED <<queue, cost, identifier, quota, dispatched, sent, acked, canceledQueued, canceledActive, stopped, atStop, retired, wrong>>
Next == Enqueue \/ Dispatch \/ Send \/ Ack \/ Complete \/ CancelQueued \/ CancelActive \/ Stop \/ Retire \/ ReleaseRetired
Spec == Init /\ [][Next]_vars
BoundedQuota == Cardinality(Active) <= quota
BoundedItems == Cardinality(Held) <= 2
BoundedBytes == Bytes <= 3
SharedIds == /\ \A job \in Active : identifier[job] # SubscriptionId
             /\ Cardinality({identifier[job] : job \in Active}) = Cardinality(Active)
NoWrongAck == ~wrong
HeldUntilSettled == \A job \in dispatched \ Held : job \in sent /\ (job \in acked \/ retired)
CanceledQueueNeverDispatches == canceledQueued \cap dispatched = {}
NoDispatchAfterStop == ~stopped \/ dispatched = atStop
===================================================================================
