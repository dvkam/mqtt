--------------------------- MODULE NativeWriteReserve ---------------------------
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
