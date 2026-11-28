------------------------ MODULE QosOneNativeAdmission ------------------------
\* Rule: A QoS 1 PUBLISH that the write budget refused before submission fails alone and returns its Packet
\* Identifier and its reservation. Any other write failure retires the session.
\* Source: src/transportCore.ts (connectOverBytes, send)
\* Source: src/nativeWriteBudget.ts (recordNativeBudgetFailure, takeNativeBudgetFailure)
\* Source: src/portable.ts (sendIdentified, transmitter)
\* Source: src/outboundQosOne.ts (OutboundQosOne, complete, finish)
\* Tests: test/native-qos-one-budget.test.ts
\* Mapping: Submit is the writer's write. Reject("budget") is send throwing the error that recordNativeBudgetFailure
\* tied to this packet, which sendIdentified recognizes with takeNativeBudgetFailure. Reject("replay") is an error
\* tied to another packet. Reject("uncertain") is an error without that record. Complete and the releases are
\* complete calling finish in OutboundQosOne. Retry is a later publish.
\* Not modeled: A refused resend, which ends the session with ERR_MQTT_SESSION_CONFLICT, and the stored publication
\* that sendIdentified forgets after a refusal.
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
