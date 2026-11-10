-------------------------- MODULE NodeCanonicalLength --------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLES continued, phase, nonminimal
vars == <<continued, phase, nonminimal>>

Init == /\ continued = 0 /\ phase = "length" /\ nonminimal = FALSE

Continuation ==
  /\ phase = "length"
  /\ IF continued = 3
     THEN /\ phase' = "rejected" /\ UNCHANGED continued
     ELSE /\ phase' = "length" /\ continued' = continued + 1
  /\ UNCHANGED nonminimal

Terminator(zero) ==
  /\ phase = "length"
  /\ nonminimal' = (continued > 0 /\ zero)
  /\ phase' = IF nonminimal' /\ Fault # "skip" THEN "rejected" ELSE "admitted"
  /\ UNCHANGED continued

Next == Continuation \/ (\E zero \in BOOLEAN: Terminator(zero))
Spec == Init /\ [][Next]_vars

CanonicalBeforeAdmission == phase = "admitted" => ~nonminimal
===============================================================================
