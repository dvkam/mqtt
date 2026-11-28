--------------------------- MODULE NativeWriteReserve ---------------------------
\* Rule: A write is admitted only when the observed buffered byte count is valid and the write fits the budget. A
\* publication also leaves the control reserve free.
\* Source: src/nativeWriteBudget.ts (allowsNativeWrite, resolveNativeWriteLimits)
\* Source: src/transportCore.ts (connectOverBytes, send)
\* Tests: test/native-write-config.test.ts, test/outgoing-tcp.test.ts
\* Mapping: Observe is a read of the writer's bufferedBytes, where -1 stands for a value that is negative or not a
\* safe integer. Admit is allowsNativeWrite with a budget of 4 units and a reserve of 1.
\* Not modeled: Frame overhead, the flush retry for corked TCP writes, kernel buffers, and what follows a refusal,
\* which QosOneNativeAdmission covers.
EXTENDS Integers
CONSTANT Fault
VARIABLES observed, projection, admissionObserved, lastTraffic
vars == <<observed, projection, admissionObserved, lastTraffic>>
Init == /\ observed = 0 /\ projection = 0 /\ admissionObserved = 0 /\ lastTraffic = "none"
Observe == /\ observed' \in -1..5 /\ UNCHANGED <<projection, admissionObserved, lastTraffic>>
Admit == \E traffic \in {"publication", "control"}, size \in 1..4:
  /\ (observed >= 0 \/ Fault = "invalid")
  /\ size <= (IF Fault = "total" THEN 5 ELSE IF traffic = "publication" /\ Fault # "reserve" THEN 3 ELSE 4) - observed
  /\ projection' = observed + size /\ observed' = projection'
  /\ admissionObserved' = observed /\ lastTraffic' = traffic
Next == Observe \/ Admit
Spec == Init /\ [][Next]_vars
BoundedProjection == projection <= 4
PublicationHeadroom == lastTraffic = "publication" => projection <= 3
ValidObservation == lastTraffic # "none" => admissionObserved >= 0
=============================================================================
