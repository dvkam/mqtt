----------------------------- MODULE BrowserAckOrder -------------------------
CONSTANT Fault
VARIABLE state
vars == <<state>>

Init ==
  \E layout \in {"coalesced", "split", "separate"}, reply \in {"accepted", "refused"},
     suffix \in {"malformed", "generic"}:
    state = [layout |-> layout, reply |-> reply, chunk |-> "first",
             decision |-> "opening", failure |-> "none", notice |-> FALSE, suffix |-> suffix]

Connack(current) ==
  [current EXCEPT !.decision = current.reply,
                  !.failure = IF current.reply = "refused" THEN "refused" ELSE "none"]

DecodeFailure(current) ==
  IF current.failure = "refused" /\ Fault # "replace"
  THEN current
  ELSE [current EXCEPT !.failure = current.suffix,
                       !.notice = (current.decision = "accepted" /\
                                   (current.suffix = "malformed" \/ Fault = "genericNotice"))]

CoalescedBatch ==
  /\ (state.layout = "coalesced" /\ state.chunk = "first")
     \/ (state.layout = "split" /\ state.chunk = "last")
  /\ LET drop == (Fault = "drop" /\ state.suffix = "malformed")
                  \/ (Fault = "genericDrop" /\ state.suffix = "generic")
         prefix == IF drop THEN state ELSE Connack(state)
     IN state' = [DecodeFailure(prefix) EXCEPT !.chunk = "done"]

FirstChunk ==
  /\ state.layout # "coalesced" /\ state.chunk = "first"
  /\ IF state.layout = "split"
     THEN state' = [state EXCEPT !.chunk = "last"]
     ELSE state' = [Connack(state) EXCEPT !.chunk = IF state.reply = "refused" THEN "done" ELSE "last"]

SeparateFailure ==
  /\ state.layout = "separate" /\ state.chunk = "last"
  /\ state' = [DecodeFailure(state) EXCEPT !.chunk = "done"]

Next == CoalescedBatch \/ FirstChunk \/ SeparateFailure
Spec == Init /\ [][Next]_vars

AcceptedPrefixReports ==
  state.chunk = "done" /\ state.reply = "accepted" /\ state.suffix = "malformed" =>
    state.decision = "accepted" /\ state.failure = "malformed" /\ state.notice

RefusalKeepsFirstCause ==
  state.chunk = "done" /\ state.reply = "refused" =>
    state.decision = "refused" /\ state.failure = "refused" /\ ~state.notice
GenericPrefixRetained ==
  state.chunk = "done" /\ state.reply = "accepted" /\ state.suffix = "generic" =>
    state.decision = "accepted" /\ state.failure = "generic"

GenericDoesNotReport ==
  state.suffix = "generic" => ~state.notice
=============================================================================
