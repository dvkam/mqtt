----------------------------- MODULE SessionEndNotice -----------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLE state
vars == <<state>>
Causes == {"disconnect", "transport", "protocol"}

Init == state = [first |-> "none", queued |-> "none", noticed |-> "none",
                 reports |-> 0, protocolStarted |-> FALSE]

Retire(cause) ==
  /\ state.first = "none"
  /\ state' = [state EXCEPT !.first = cause, !.queued = IF Fault = "omit" THEN "none" ELSE cause]

Repeat(cause) ==
  /\ Fault = "replace" /\ state.first # "none" /\ state.queued # "none"
  /\ state' = [state EXCEPT !.queued = cause]

StartProtocolNotice ==
  /\ state.first = "protocol" /\ ~state.protocolStarted
  /\ state' = [state EXCEPT !.protocolStarted = TRUE]

Deliver ==
  /\ state.queued # "none"
  /\ state.reports < 2
  /\ state.first # "protocol" \/ state.protocolStarted \/ Fault = "early"
  /\ state' = [state EXCEPT !.noticed = state.queued, !.reports = @ + 1,
                            !.queued = IF Fault = "repeat" THEN state.queued ELSE "none"]

Next == (\E cause \in Causes: Retire(cause) \/ Repeat(cause)) \/ StartProtocolNotice \/ Deliver
Spec == Init /\ [][Next]_vars

RetirementQueuesNotice == state.first # "none" => state.queued # "none" \/ state.reports > 0
OneRetirementNotice == state.reports <= 1
NoticeUsesFirstCause == state.noticed # "none" => state.noticed = state.first
ProtocolNoticeStartsFirst == state.noticed = "protocol" => state.protocolStarted
=====================================================================================
