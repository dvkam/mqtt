----------------------------- MODULE OperationTimeout -----------------------------
\* Rule: An operation timeout retires the session in the timer callback, rejects every pending operation, requests
\* one forced close, and stays the cause.
\* Source: src/portable.ts (run, abort, fail, pendingOperations, forcedClose)
\* Tests: test/operation-timeout.test.ts
\* Mapping: Expire is the timer in run calling abort, whose fail records the failure and rejects pendingOperations.
\* Admit is a publish, subscribe or ping after the timeout, which throws the failure. Cleanup is a later abort,
\* which reuses forcedClose. LateFailure is a later fail, which the failure guard ignores.
\* Not modeled: Clocks, the deadline owners that leave shutdown to disconnect(), and the QoS 0 write deadline, which
\* QosZeroDeadline covers.
EXTENDS Naturals
CONSTANT Fault
VARIABLES retired, pending, expired, reason, sends, requests, cleanupSeen, lateSeen
vars == <<retired, pending, expired, reason, sends, requests, cleanupSeen, lateSeen>>
Init == /\ retired = FALSE /\ pending = {1, 2} /\ expired = FALSE
        /\ reason = "none" /\ sends = 2 /\ requests = 0
        /\ cleanupSeen = FALSE /\ lateSeen = FALSE
Expire == /\ ~expired /\ expired' = TRUE
          /\ retired' = (Fault # "defer")
          /\ reason' = IF Fault = "defer" THEN "none" ELSE "timeout"
          /\ pending' = IF Fault = "defer" THEN pending ELSE IF Fault = "single" THEN {2} ELSE {}
          /\ requests' = IF Fault = "defer" THEN 0 ELSE 1
          /\ UNCHANGED <<sends, cleanupSeen, lateSeen>>
DeferredRetire == /\ expired /\ ~retired /\ retired' = TRUE /\ reason' = "timeout"
                  /\ pending' = {} /\ requests' = 1
                  /\ UNCHANGED <<expired, sends, cleanupSeen, lateSeen>>
Admit == /\ ~retired /\ expired /\ sends = 2 /\ sends' = 3
         /\ UNCHANGED <<retired, pending, expired, reason, requests, cleanupSeen, lateSeen>>
Cleanup == /\ retired /\ ~cleanupSeen /\ cleanupSeen' = TRUE
           /\ requests' = IF Fault = "duplicate" THEN requests + 1 ELSE requests
           /\ UNCHANGED <<retired, pending, expired, reason, sends, lateSeen>>
LateFailure == /\ retired /\ ~lateSeen /\ lateSeen' = TRUE
               /\ reason' = IF Fault = "overwrite" THEN "late" ELSE reason
               /\ UNCHANGED <<retired, pending, expired, sends, requests, cleanupSeen>>
Next == Expire \/ DeferredRetire \/ Admit \/ Cleanup \/ LateFailure
Spec == Init /\ [][Next]_vars
NoAdmissionAfterTimeout == expired => sends = 2
AllPendingRetired == retired => pending = {}
OneForcedClose == requests <= 1
FirstTimeoutCause == retired => reason = "timeout"
=============================================================================
