----------------------------- MODULE SessionEndNotice -----------------------------
\* Rule: The first retirement queues one session end notice with its cause. For a protocol failure the DISCONNECT
\* notice starts before the observer runs.
\* Source: src/portable.ts (fail, abort, reportProtocolError, onSessionEnd)
\* Source: src/diagnostics.ts (notifyObserver)
\* Tests: test/portable.test.ts, test/browser-client.test.ts
\* Mapping: Retire is fail recording the failure and queueing the observer in a microtask. StartProtocolNotice is
\* abort creating forcedClose, whose microtask is queued before fail queues the observer, so reportProtocolError
\* starts first. Deliver is the observer microtask.
\* Not modeled: Error identity, the list of uncertain publications, whether the observer completes, and physical
\* closure.
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
