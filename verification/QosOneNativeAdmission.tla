------------------------ MODULE QosOneNativeAdmission ------------------------
CONSTANT Fault
VARIABLE state
vars == <<state>>

Init == state = [phase |-> "reserved", live |-> TRUE, identifier |-> TRUE,
                 publication |-> TRUE, submitted |-> FALSE, writeDone |-> FALSE,
                 acked |-> FALSE, cause |-> "none", retry |-> FALSE]

Submit ==
  /\ state.phase = "reserved"
  /\ state' = [state EXCEPT !.phase = "submitted", !.submitted = TRUE]

WriteCompletes ==
  /\ state.phase = "submitted" /\ ~state.writeDone
  /\ state' = [state EXCEPT !.writeDone = TRUE]

Ack ==
  /\ state.phase = "submitted" /\ ~state.acked
  /\ state' = [state EXCEPT !.acked = TRUE]

Complete ==
  /\ state.phase = "submitted" /\ state.acked /\ state.writeDone
  /\ state' = [state EXCEPT !.phase = "complete", !.identifier = FALSE, !.publication = FALSE]

Reject(cause) ==
  /\ state.phase \in {"reserved", "submitted"}
  /\ cause # "budget" \/ ~state.submitted
  /\ LET local == cause = "budget" \/ (cause = "replay" /\ Fault = "replay")
                    \/ (cause = "uncertain" /\ Fault = "uncertain")
     IN state' = [state EXCEPT !.phase = "rejected", !.cause = cause,
                 !.live = local /\ Fault # "retire",
                 !.identifier = local /\ Fault = "lease",
                 !.publication = local /\ Fault = "publication"]

Retry ==
  /\ state.phase = "rejected" /\ state.live /\ ~state.retry
  /\ ~state.identifier /\ ~state.publication
  /\ state' = [state EXCEPT !.retry = TRUE]

Next == Submit \/ WriteCompletes \/ Ack \/ Complete \/
        (\E cause \in {"budget", "replay", "uncertain"}: Reject(cause)) \/ Retry
Spec == Init /\ [][Next]_vars

RefusalKeepsSession == state.cause = "budget" => state.live /\ ~state.submitted
RefusalReleasesIdentifier == state.cause = "budget" => ~state.identifier
RefusalReleasesPublication == state.cause = "budget" => ~state.publication
UncertainRetires == state.cause = "uncertain" => ~state.live
ReplayRetires == state.cause = "replay" => ~state.live
CompletionHasWriteAndAck == state.phase = "complete" => state.writeDone /\ state.acked
=============================================================================
