--------------------------- MODULE PacketDiagnostics --------------------------
CONSTANT Fault
VARIABLES outcome, reported
vars == <<outcome, reported>>

Init == outcome = "pending" /\ ~reported
Dispatch(result) == outcome = "pending" /\ outcome' = result /\ UNCHANGED reported
Report == ~reported /\ (outcome = "returned" \/ (outcome = "threw" /\ Fault = "finally"))
          /\ reported' = TRUE /\ UNCHANGED outcome
Next == (\E result \in {"returned", "threw"}: Dispatch(result)) \/ Report
Spec == Init /\ [][Next]_vars
ReportOnlyAfterReturn == reported => outcome = "returned"
==============================================================================
