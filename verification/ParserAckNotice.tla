---------------------------- MODULE ParserAckNotice ----------------------------
CONSTANT Fault
VARIABLE state
vars == <<state>>

Init == state = [phase |-> "opening", failed |-> FALSE, read |-> TRUE,
                 report |-> "none", closed |-> FALSE]
Accept == /\ state.phase = "opening" /\ ~state.failed
          /\ state' = [state EXCEPT !.phase = "active"]
Stop == /\ state.phase = "active" /\ ~state.failed
        /\ state' = [state EXCEPT !.phase = "graceful"]
Reject == /\ ~state.failed
          /\ state' = [state EXCEPT !.failed = TRUE, !.read = (Fault = "read"),
                        !.report = IF state.phase = "active" \/ Fault = state.phase THEN "pending" ELSE "none"]
ReportSettles == /\ state.report = "pending" /\ ~state.closed
                 /\ state' = [state EXCEPT !.report = "settled"]
Close == /\ state.failed /\ ~state.closed
         /\ (state.report # "pending" \/ Fault = "close")
         /\ state' = [state EXCEPT !.closed = TRUE]

Next == Accept \/ Stop \/ Reject \/ ReportSettles \/ Close
Spec == Init /\ [][Next]_vars

InputFenced == state.failed => ~state.read
NoticeOnActiveOnly == state.report # "none" => state.phase = "active"
ReportBeforeLocalClose == state.closed => state.report # "pending"
=============================================================================
