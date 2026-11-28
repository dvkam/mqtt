--------------------------- MODULE PacketDiagnostics --------------------------
\* Rule: A packet diagnostic is reported only after the send or receive call returned.
\* Source: src/diagnostics.ts (packetSender, packetReceiver, reportPacket)
\* Tests: test/portable.test.ts
\* Mapping: Dispatch is transport.send or the receive callback. Report is reportPacket on the line after that call,
\* which a throw skips.
\* Not modeled: The send promise settling, observer failures, which DiagnosticRetirement covers, and connection
\* diagnostics.
CONSTANT Fault
VARIABLES outcome, reported
vars == <<outcome, reported>>

Init == outcome = "pending" /\ reported = FALSE
Dispatch(result) == outcome = "pending" /\ outcome' = result /\ UNCHANGED reported
Report == ~reported /\ (outcome = "returned" \/ (outcome = "threw" /\ Fault = "finally"))
          /\ reported' = TRUE /\ UNCHANGED outcome
Next == (\E result \in {"returned", "threw"}: Dispatch(result)) \/ Report
Spec == Init /\ [][Next]_vars
ReportOnlyAfterReturn == reported => outcome = "returned"
==============================================================================
