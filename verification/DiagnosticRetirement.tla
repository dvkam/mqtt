--------------------------- MODULE DiagnosticRetirement ----------------------
\* Rule: A diagnostic observer that throws does not fail the session. A session that retired before or during the
\* active notification is not returned to the caller.
\* Source: src/portable.ts (open, reportConnection, advanceInbound)
\* Source: src/diagnostics.ts (notifyObserver)
\* Tests: test/portable.test.ts
\* Mapping: Observe is reportConnection calling the observer through notifyObserver. Outcome "retired" is an
\* observer that ends the session. AlreadyRetired is a failure recorded before the notification, for example by a
\* QoS 1 handler that advanceInbound started. Complete is open, which throws the recorded failure or returns the
\* connection.
\* Not modeled: Observers that reject later, packet diagnostics, which PacketDiagnostics covers, and timing.
CONSTANT Fault
VARIABLE state
vars == <<state>>

Init == \E failure \in {"none", "transport"}:
  state = [phase |-> "active", observed |-> "none", failure |-> failure, handedOff |-> FALSE]

Observe(outcome) ==
  /\ state.phase = "active" /\ state.failure = "none"
  /\ state' = [state EXCEPT !.phase = "observed", !.observed = outcome,
                         !.failure = IF outcome = "retired" THEN "transport"
                                      ELSE IF outcome = "threw" /\ Fault = "throw" THEN "observer"
                                      ELSE "none"]

AlreadyRetired ==
  /\ state.phase = "active" /\ state.failure = "transport"
  /\ state' = [state EXCEPT !.phase = "observed", !.observed = "prior"]

Complete ==
  /\ state.phase = "observed"
  /\ state' = [state EXCEPT !.phase = "done",
                         !.handedOff = (state.failure = "none" \/ Fault = "handoff")]

Next == (\E outcome \in {"returned", "threw", "retired"}: Observe(outcome)) \/ AlreadyRetired \/ Complete
Spec == Init /\ [][Next]_vars

ObserverFailureIsolated == state.observed = "threw" => state.failure = "none"
RetirementFencesHandoff == state.observed \in {"retired", "prior"} => ~state.handedOff /\ state.failure = "transport"
==============================================================================
