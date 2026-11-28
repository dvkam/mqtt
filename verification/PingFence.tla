------------------------------ MODULE PingFence ------------------------------
\* Rule: A failed ping exchange retires the session before the acknowledgment slot is free. A late PINGRESP cannot
\* complete a later PINGREQ, and no PINGREQ follows a failure.
\* Source: src/portable.ts (exchange, exchangePing, ping, abort, pendingAck)
\* Tests: test/portable.test.ts, test/server-keep-alive.test.ts
\* Mapping: Request is exchange installing pendingAck before it writes PINGREQ, for a manual or an automatic ping.
\* Receive is a PINGRESP reaching pendingAck. FailExchange is a timeout or a failed write, where the catch in
\* exchange awaits abort before the finally block clears the slot. Close is any other retirement. UnsafeRetry = TRUE
\* keeps the session active after a failure.
\* Not modeled: Clocks, the Server Keep Alive schedule, and a PINGRESP that is unsolicited or repeated. Reply
\* identity is a model label, because PINGRESP carries no identifier.
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
