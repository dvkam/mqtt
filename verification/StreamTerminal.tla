---------------------------- MODULE StreamTerminal ----------------------------
\* Rule: The stream view closes at once on a graceful close with nothing queued, errors at once on a failure, and
\* does not close before it enqueued a message that a pending pull already took.
\* Source: test/experiments/message-queue.ts (createMessageQueue, stream, notifyTerminal, pull)
\* Tests: test/browser-message-stream.test.ts
\* Mapping: Offer is push. Pull is the pull callback up to its await. Resume is its continuation. Close and Fail are
\* close and fail calling notifyTerminal. Cancel is the stream's cancel callback.
\* Not modeled: More than one message, backpressure and the batch view, which ReadyBatch covers.
\* This model covers test-only code under test/experiments. The package does not export the queue.
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, queued, pulling, result, terminal, accepted, delivered
vars == <<phase, queued, pulling, result, terminal, accepted, delivered>>
Init == /\ phase = "open" /\ queued = FALSE /\ pulling = FALSE /\ result = "none"
        /\ terminal = FALSE /\ accepted = FALSE /\ delivered = FALSE
Offer == /\ phase = "open" /\ ~accepted /\ accepted' = TRUE
         /\ IF pulling THEN /\ result' = "message" /\ UNCHANGED queued
                       ELSE /\ queued' = TRUE /\ UNCHANGED result
         /\ UNCHANGED <<phase, pulling, terminal, delivered>>
Pull == /\ ~terminal /\ ~pulling /\ pulling' = TRUE
        /\ result' = IF queued THEN "message" ELSE IF phase = "closing" THEN "end" ELSE "none"
        /\ queued' = FALSE
        /\ UNCHANGED <<phase, terminal, accepted, delivered>>
Resume == /\ pulling /\ result # "none"
          /\ delivered' = (delivered \/ (result = "message" /\ ~terminal))
          /\ terminal' = (terminal \/ result = "end" \/ (phase = "closing" /\ ~queued))
          /\ pulling' = FALSE /\ result' = "none"
          /\ UNCHANGED <<phase, queued, accepted>>
Close == /\ phase = "open" /\ phase' = "closing"
         /\ terminal' = (terminal \/ (~queued /\ (~pulling \/ Fault = "handoff") /\ Fault # "idle-close"))
         /\ result' = IF pulling /\ result = "none" THEN "end" ELSE result
         /\ UNCHANGED <<queued, pulling, accepted, delivered>>
Fail == /\ phase = "open" /\ phase' = "failed" /\ queued' = FALSE
        /\ terminal' = (Fault # "idle-fail")
        /\ result' = IF pulling THEN "end" ELSE result
        /\ UNCHANGED <<pulling, accepted, delivered>>
Cancel == /\ phase \in {"open", "closing"} /\ phase' = "cancelled"
          /\ queued' = FALSE /\ terminal' = TRUE
          /\ result' = IF pulling THEN "end" ELSE result
          /\ UNCHANGED <<pulling, accepted, delivered>>
Next == Offer \/ Pull \/ Resume \/ Close \/ Fail \/ Cancel
Spec == Init /\ [][Next]_vars
EmptyCompletion == (phase = "closing" /\ ~queued /\ ~pulling) => terminal
FailureSettles == phase = "failed" => terminal
PreserveHandedMessage == (phase = "closing" /\ result = "message" /\ ~delivered) => ~terminal
=============================================================================
