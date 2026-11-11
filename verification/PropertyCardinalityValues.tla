----------------------- MODULE PropertyCardinalityValues -----------------------
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLES phase, seen, reads, duplicatePassed, scalarPassed, repeatRejected, delivered
vars == <<phase, seen, reads, duplicatePassed, scalarPassed, repeatRejected, delivered>>
Identifiers == {"flag", "nonzero", "topic", "width", "repeat", "repeatNonzero"}
Repeatable(identifier) == identifier \in {"repeat", "repeatNonzero"}
ValueValid(identifier, value) ==
  CASE identifier = "flag" -> value \in {0, 1}
    [] identifier \in {"nonzero", "repeatNonzero"} -> value > 0
    [] identifier = "topic" -> value = 1
    [] OTHER -> TRUE

Init == /\ phase = "walking" /\ seen = {} /\ reads = 0
        /\ duplicatePassed = FALSE /\ scalarPassed = FALSE
        /\ repeatRejected = FALSE /\ delivered = FALSE

Read(identifier, value) ==
  /\ phase = "walking" /\ reads < 3
  /\ LET duplicate == identifier \in seen /\ (~Repeatable(identifier) \/ Fault = "repeat")
         valid == ValueValid(identifier, value)
         accepted == (~duplicate \/ Fault = "duplicate") /\ (valid \/ Fault = "scalar")
     IN /\ phase' = IF accepted THEN "walking" ELSE "failed"
        /\ seen' = IF accepted /\ (~Repeatable(identifier) \/ Fault = "repeat")
                    THEN seen \cup {identifier} ELSE seen
        /\ duplicatePassed' = (duplicatePassed \/ (accepted /\ duplicate))
        /\ scalarPassed' = (scalarPassed \/ (accepted /\ ~valid))
        /\ repeatRejected' = (repeatRejected
              \/ (duplicate /\ Repeatable(identifier) /\ valid /\ ~accepted))
  /\ reads' = reads + 1
  /\ UNCHANGED delivered

Finish == /\ phase = "walking" /\ phase' = "ready"
          /\ UNCHANGED <<seen, reads, duplicatePassed, scalarPassed, repeatRejected, delivered>>
Dispatch == /\ phase = "ready" /\ phase' = "dispatched" /\ delivered' = TRUE
            /\ UNCHANGED <<seen, reads, duplicatePassed, scalarPassed, repeatRejected>>
Next == (\E identifier \in Identifiers, value \in {0, 1, 2}: Read(identifier, value)) \/ Finish \/ Dispatch
Spec == Init /\ [][Next]_vars
SingletonsBeforeDispatch == delivered => ~duplicatePassed
ScalarsBeforeDispatch == delivered => ~scalarPassed
AllowedRepetitionPreserved == ~repeatRejected
BoundedSingletonTracking == Cardinality(seen) <= 3
=============================================================================
