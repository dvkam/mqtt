--------------------------- MODULE QosZeroDeadline ----------------------------
\* Rule: One timer covers every pending QoS 0 write. Each write keeps its own deadline. The session retires no
\* earlier than the earliest deadline, and retirement clears every pending write.
\* Source: src/qosZeroWrites.ts (QosZeroWrites, run, wake, arm, retire)
\* Source: src/portable.ts (publish)
\* Tests: test/operation-timeout.test.ts
\* Mapping: Write is run. Finish is a write settling, where run compares the earliest deadline with the clock. Tick
\* is the clock. Wake is wake, which arms the timer for the earliest pending write or calls onTimeout.
\* Not modeled: Timer ref and unref, clock granularity, and QoS 0 writes that wait for resends.
EXTENDS Naturals
CONSTANT Fault
VARIABLES now, timer, deadlines, issued, retired, expiredDeadline
vars == <<now, timer, deadlines, issued, retired, expiredDeadline>>

Ids == 1..2
Budget == 2
Active == {id \in Ids : deadlines[id] # 0}
Expiries == {deadlines[id] : id \in Active}
Earliest == CHOOSE deadline \in Expiries : \A other \in Expiries : deadline <= other

Init == /\ now = 0 /\ timer = 0 /\ deadlines = [id \in Ids |-> 0]
        /\ issued = {} /\ retired = FALSE /\ expiredDeadline = 0

Write(id) == /\ ~retired /\ id \notin issued /\ now <= 3
             /\ deadlines' = [deadlines EXCEPT ![id] = now + Budget]
             /\ timer' = IF timer = 0 THEN now + Budget ELSE timer
             /\ issued' = issued \cup {id}
             /\ UNCHANGED <<now, retired, expiredDeadline>>

Finish(id) == /\ id \in Active /\ ~retired
              /\ LET expire == now >= Earliest
                 IN /\ retired' = expire
                    /\ expiredDeadline' = IF expire THEN Earliest ELSE 0
                    /\ deadlines' = IF expire THEN [write \in Ids |-> 0] ELSE [deadlines EXCEPT ![id] = 0]
                    /\ timer' = IF expire THEN 0 ELSE timer
              /\ UNCHANGED <<now, issued>>

Tick == /\ now < 5 /\ (timer = 0 \/ now < timer)
        /\ now' = now + 1
        /\ UNCHANGED <<timer, deadlines, issued, retired, expiredDeadline>>

Wake == /\ timer # 0 /\ timer = now /\ ~retired
        /\ LET earliest == IF Active = {} THEN 0 ELSE Earliest
               expire == earliest # 0 /\ (earliest <= now \/ Fault = "early")
           IN /\ retired' = expire
              /\ expiredDeadline' = IF expire THEN earliest ELSE 0
              /\ timer' = IF expire \/ Fault = "drop" THEN 0 ELSE earliest
              /\ deadlines' = IF expire /\ Fault # "pending" THEN [id \in Ids |-> 0] ELSE deadlines
        /\ UNCHANGED <<now, issued>>

Next == Tick \/ Wake \/ (\E id \in Ids : Write(id) \/ Finish(id))
Spec == Init /\ [][Next]_vars

TimerCoversWrites == (~retired /\ Active # {}) => (timer # 0 /\ timer <= Earliest)
RetiresAtOwnDeadline == retired => (expiredDeadline # 0 /\ now >= expiredDeadline)
ClearsPendingOnRetire == retired => Active = {}
=============================================================================
