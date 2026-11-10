--------------------------- MODULE DiagnosticRetirement ----------------------
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
