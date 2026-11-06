------------------------------ MODULE PingFence ------------------------------
EXTENDS Naturals, FiniteSets

CONSTANT UnsafeRetry
VARIABLES phase, issued, pending, replies, wrong, expired
vars == <<phase, issued, pending, replies, wrong, expired>>

Init ==
  /\ phase = "active"
  /\ issued = 0
  /\ pending = 0
  /\ replies = {}
  /\ wrong = FALSE
  /\ expired = 0

Request ==
  /\ phase = "active"
  /\ pending = 0
  /\ issued < 2
  /\ issued' = issued + 1
  /\ pending' = issued'
  /\ replies' = replies \cup {issued'}
  /\ UNCHANGED <<phase, wrong, expired>>

Receive ==
  \E reply \in replies:
    /\ replies' = replies \ {reply}
    /\ pending' = IF phase = "active" THEN 0 ELSE pending
    /\ wrong' = (wrong \/ (phase = "active" /\ pending # 0 /\ reply # pending))
    /\ UNCHANGED <<phase, issued, expired>>

FailExchange ==
  /\ pending # 0
  /\ pending' = 0
  /\ expired' = issued
  /\ phase' = IF UnsafeRetry THEN "active" ELSE "retired"
  /\ UNCHANGED <<issued, replies, wrong>>

Close ==
  /\ UNCHANGED expired
  /\ phase = "active"
  /\ phase' = "retired"
  /\ pending' = 0
  /\ UNCHANGED <<issued, replies, wrong>>

Next == Request \/ Receive \/ FailExchange \/ Close
Spec == Init /\ [][Next]_vars

NoWrongReply == ~wrong
NoSendAfterFailure == expired = 0 \/ issued = expired
=============================================================================
