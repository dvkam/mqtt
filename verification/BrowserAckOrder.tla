----------------------------- MODULE BrowserAckOrder -------------------------
CONSTANT Fault
VARIABLE state
vars == <<state>>

Init ==
  \E layout \in {"coalesced", "split", "separate"}, reply \in {"accepted", "refused"}:
    state = [layout |-> layout, reply |-> reply, chunk |-> "first",
             decision |-> "opening", failure |-> "none", notice |-> FALSE]

Connack(current) ==
  [current EXCEPT !.decision = current.reply,
                  !.failure = IF current.reply = "refused" THEN "refused" ELSE "none"]

MalformedAck(current) ==
  IF current.failure = "refused" /\ Fault # "replace"
  THEN current
  ELSE [current EXCEPT !.failure = "malformed", !.notice = (current.decision = "accepted")]

CoalescedBatch ==
  /\ (state.layout = "coalesced" /\ state.chunk = "first")
     \/ (state.layout = "split" /\ state.chunk = "last")
  /\ LET prefix == IF Fault = "drop" THEN state ELSE Connack(state)
     IN state' = [MalformedAck(prefix) EXCEPT !.chunk = "done"]

FirstChunk ==
  /\ state.layout # "coalesced" /\ state.chunk = "first"
  /\ IF state.layout = "split"
     THEN state' = [state EXCEPT !.chunk = "last"]
     ELSE state' = [Connack(state) EXCEPT !.chunk = IF state.reply = "refused" THEN "done" ELSE "last"]

SeparateAck ==
  /\ state.layout = "separate" /\ state.chunk = "last"
  /\ state' = [MalformedAck(state) EXCEPT !.chunk = "done"]

Next == CoalescedBatch \/ FirstChunk \/ SeparateAck
Spec == Init /\ [][Next]_vars

AcceptedPrefixReports ==
  state.chunk = "done" /\ state.reply = "accepted" =>
    state.decision = "accepted" /\ state.failure = "malformed" /\ state.notice

RefusalKeepsFirstCause ==
  state.chunk = "done" /\ state.reply = "refused" =>
    state.decision = "refused" /\ state.failure = "refused" /\ ~state.notice
=============================================================================
