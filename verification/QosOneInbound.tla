---------------------------- MODULE QosOneInbound ----------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLE state
vars == <<state>>

Init == state = [status |-> "opening", phase |-> "idle", queued |-> 0,
                 succeeded |-> FALSE, openingReceived |-> FALSE, violation |-> "none"]

Accept == /\ state.status = "opening"
          /\ state' = [state EXCEPT !.status = "accepted"]

Activate == /\ state.status = "accepted"
            /\ state' = [state EXCEPT !.status = "active", !.queued = 0,
                          !.phase = IF state.queued = 1 THEN "handling" ELSE "idle"]

Receive ==
    /\ state.status \in {"accepted", "active"}
    /\ CASE state.status = "accepted" /\ state.queued = 0 ->
                state' = [state EXCEPT !.openingReceived = TRUE,
                          !.queued = IF Fault = "opening" THEN 0 ELSE 1]
         [] state.status = "active" /\ state.phase = "idle" ->
                state' = [state EXCEPT !.phase = "handling"]
         [] state.phase = "acknowledging" /\ state.queued = 0 ->
                state' = [state EXCEPT !.queued = 1]
         [] OTHER ->
                IF Fault = "budget" /\ state.queued = 1
                THEN state' = [state EXCEPT !.queued = 2]
                ELSE state' = [state EXCEPT !.status = "retired", !.queued = 0]

HandlerSuccess == /\ state.phase = "handling" /\ ~state.succeeded
                  /\ state' = [state EXCEPT !.succeeded = TRUE]

AckStart ==
    /\ state.phase = "handling"
    /\ (state.succeeded \/ Fault = "early")
    /\ (state.status = "active" \/ Fault = "late")
    /\ state' = [state EXCEPT !.phase = "acknowledging",
                  !.violation = IF state.status # "active" THEN "late"
                                ELSE IF ~state.succeeded THEN "early" ELSE @]

AckSettled ==
    /\ state.phase = "acknowledging"
    /\ state' = [state EXCEPT !.queued = 0, !.succeeded = FALSE,
                  !.phase = IF state.status = "active" /\ state.queued = 1 THEN "handling" ELSE "idle"]

AdvanceEarly == /\ Fault = "advance" /\ state.status = "active"
                /\ state.phase = "acknowledging" /\ state.queued = 1
                /\ state' = [state EXCEPT !.phase = "handling", !.queued = 0,
                              !.succeeded = FALSE, !.violation = "advance"]

Stop == /\ state.status = "active"
        /\ state' = [state EXCEPT !.status = "stopping", !.queued = IF Fault = "retention" THEN @ ELSE 0]

Fail == /\ state.status \in {"opening", "accepted", "active", "stopping"}
        /\ state' = [state EXCEPT !.status = "retired", !.queued = 0]

HandlerFailure ==
    /\ state.phase \in {"handling", "acknowledging"}
    /\ (state.status = "active" \/ (state.status = "stopping" /\ Fault = "force"))
    /\ state' = [state EXCEPT !.status = "retired", !.queued = 0,
                  !.violation = IF state.status = "stopping" THEN "force" ELSE @]

Next == Accept \/ Activate \/ Receive \/ HandlerSuccess \/ AckStart \/ AckSettled \/ AdvanceEarly \/ Stop \/ Fail \/ HandlerFailure
Spec == Init /\ [][Next]_vars

BoundedFollower == state.queued <= 1
PreserveOpeningMessage == (state.status = "accepted" /\ state.openingReceived) => state.queued = 1
AckAfterHandler == state.violation # "early"
NoAckAfterStop == state.violation # "late"
NoDispatchBeforeAckSettles == state.violation # "advance"
TerminalClearsFollower == (state.status \in {"stopping", "retired"}) => state.queued = 0
GracefulCloseOwnsRetirement == state.violation # "force"
=============================================================================
