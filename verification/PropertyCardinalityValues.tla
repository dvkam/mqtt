----------------------- MODULE PropertyCardinalityValues -----------------------
\* Rule: A property that may appear once is rejected when it repeats. A flag or a nonzero property is rejected when
\* its value is out of range. User Property and Subscription Identifier may repeat.
\* Source: src/wireProperties.ts (readProperties, Section, flag, nonzero, duplicate, responseTopic)
\* Tests: test/property-cardinality-values.test.ts
\* Mapping: Read is one turn of the loop in readProperties. Identifier "flag" is a property read with flag,
\* "nonzero" one checked with nonzero, "topic" the Response Topic, "width" a fixed-width integer without a range
\* rule, "repeat" the User Property and "repeatNonzero" the Subscription Identifier.
\* Not modeled: Which packet types allow an identifier, string bytes, which NodeConnackProperties covers, and Topic
\* Alias, which fails with a reason code of its own.
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
