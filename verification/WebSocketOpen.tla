------------------------------ MODULE WebSocketOpen ------------------------------
EXTENDS Naturals

CONSTANT KeepOpenListener
VARIABLES outcome, listening, count, closeRequests
vars == <<outcome, listening, count, closeRequests>>

Init ==
  /\ outcome = "pending"
  /\ listening = TRUE
  /\ count = 0
  /\ closeRequests = 0

Open ==
  /\ listening
  /\ outcome' = "opened"
  /\ listening' = FALSE
  /\ count' = count + 1
  /\ UNCHANGED closeRequests

Fail ==
  /\ outcome = "pending"
  /\ outcome' = "rejected"
  /\ listening' = KeepOpenListener
  /\ count' = count + 1
  /\ closeRequests' = closeRequests + 1

Next == Open \/ Fail
Spec == Init /\ [][Next]_vars
TerminalOwnership == count <= 1 /\ closeRequests <= 1
=============================================================================
