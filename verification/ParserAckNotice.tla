---------------------------- MODULE ParserAckNotice ----------------------------
\* Rule: A classified protocol rejection stops inbound reads at once. It sends a DISCONNECT notice only after
\* CONNACK and before a graceful close, and the forced close waits until that notice settled.
\* Source: src/packetInput.ts (PacketInput, push, detachCore)
\* Source: src/portable.ts (rejectProtocolInput, abort, reportProtocolError)
\* Tests: test/browser-client.test.ts, test/tcp-client.test.ts
\* Mapping: Accept is receiveConnack accepting the CONNACK. Stop is disconnect setting closing. Reject is
\* PacketInput.push catching a ProtocolInputError, detaching the session and calling rejectProtocolInput.
\* ReportSettles is the DISCONNECT write or its deadline in reportProtocolError. Close is the forced transport close
\* in abort.
\* Not modeled: Peer closure, whether the write succeeded, and the bytes of the notice.
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
