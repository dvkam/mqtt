----------------------------- MODULE QosTwoInbound -----------------------------
\* Rule: One inbound QoS 2 exchange reaches the handler at most once, also across a resumed session. A publication of
\* this connection holds the one receive slot until its PUBREL. A failed handler forgets the Packet Identifier, and the
\* session answers no PUBREL after a stop.
\* Source: src/portable.ts (receiveQosOne, deliverQosTwo, receiveRelease, answer, advanceInbound, disconnect)
\* Source: src/sessionState.ts (inbound, resume)
\* Tests: test/qos2-inbound.test.ts, test/qos2-resume.test.ts
\* Mapping: Publish is receiveQosOne with its duplicate check. Start is deliverQosTwo recording the identifier
\* and calling onQosTwoMessage. HandlerSuccess is the PUBREC write and HandlerFailure the catch in deliverQosTwo.
\* Release is receiveRelease. CompleteSettled is the settled PUBCOMP write in answer, which calls advanceInbound.
\* Stop is disconnect. Drop ends the connection. Resume and Fresh are resume in the session state.
\* Not modeled: The opening and accepted phases, QoS 1 publications in the same slot, the PUBCOMP for an unknown
\* identifier, and a handler that fails after a later connection answered its duplicate. Drop decides at once whether a
\* handler that still runs fulfills or fails.
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLES status, slot, live, follower, delivered, handled, window, drops, violation
vars == <<status, slot, live, follower, delivered, handled, window, drops, violation>>

Ids == {1, 2}
None == 0

Init == /\ status = "active" /\ slot = "idle" /\ live = None /\ follower = None
        /\ delivered = {} /\ handled = [id \in Ids |-> 0]
        /\ window = {} /\ drops = 0 /\ violation = "none"

Retire == /\ status' = "retired" /\ slot' = "idle" /\ live' = None /\ follower' = None
          /\ window' = {}

\* The session records the Packet Identifier, then runs the handler.
Start(id) == /\ slot' = "handling" /\ live' = id
             /\ delivered' = delivered \cup {id}
             /\ handled' = [handled EXCEPT ![id] = @ + 1]
             /\ window' = window \cup {id}

\* A QoS 2 PUBLISH arrives. A recorded Packet Identifier makes it a duplicate.
Publish == \E id \in Ids:
  /\ status = "active"
  /\ IF id \in delivered /\ Fault # "duplicate"
     THEN UNCHANGED vars
     ELSE IF slot = "idle"
     THEN Start(id) /\ UNCHANGED <<status, follower, drops, violation>>
     ELSE IF slot = "acknowledging" /\ follower = None
     THEN follower' = id /\ UNCHANGED <<status, slot, live, delivered, handled, window, drops, violation>>
     ELSE Retire /\ UNCHANGED <<delivered, handled, drops, violation>>

\* The handler fulfilled. An active session sends PUBREC and keeps the slot until PUBREL.
HandlerSuccess ==
  /\ slot = "handling"
  /\ IF status = "active"
     THEN /\ slot' = IF Fault = "slot" THEN "idle" ELSE "releasing"
          /\ UNCHANGED <<status, live, follower, delivered, handled, window, drops, violation>>
     ELSE /\ slot' = "idle" /\ live' = None
          /\ UNCHANGED <<status, follower, delivered, handled, window, drops, violation>>

\* The handler failed. The session ends without PUBREC and forgets the Packet Identifier.
HandlerFailure ==
  /\ slot = "handling" /\ status \in {"active", "stopping"}
  /\ delivered' = IF Fault = "keep" THEN delivered ELSE delivered \ {live}
  /\ handled' = [handled EXCEPT ![live] = @ - 1]
  /\ violation' = IF Fault = "keep" THEN "keep" ELSE violation
  /\ Retire /\ UNCHANGED drops

\* PUBREL arrives. A recorded Packet Identifier gets PUBCOMP and leaves the record.
Release == \E id \in Ids:
  /\ status \in {"active", "stopping"}
  /\ IF status = "stopping"
     THEN /\ Fault = "late" /\ violation' = "late"
          /\ UNCHANGED <<status, slot, live, follower, delivered, handled, window, drops>>
     ELSE IF live = id /\ slot = "handling"
     THEN Retire /\ UNCHANGED <<delivered, handled, drops, violation>>
     ELSE IF id \notin delivered
     THEN UNCHANGED vars
     ELSE /\ delivered' = delivered \ {id}
          /\ handled' = [handled EXCEPT ![id] = 0]
          /\ window' = window \ {id}
          /\ IF live = id
             THEN slot' = "acknowledging" /\ live' = None
             ELSE UNCHANGED <<slot, live>>
          /\ UNCHANGED <<status, follower, drops, violation>>

\* The PUBCOMP write settled, so the retained next PUBLISH is handled.
CompleteSettled ==
  /\ slot = "acknowledging"
  /\ IF follower # None /\ status = "active" /\ follower \notin delivered
     THEN Start(follower) /\ follower' = None /\ UNCHANGED <<status, drops, violation>>
     ELSE slot' = "idle" /\ follower' = None /\ UNCHANGED <<status, live, delivered, handled, window, drops, violation>>

\* disconnect() discards the retained PUBLISH and answers nothing more.
Stop == /\ status = "active" /\ status' = "stopping" /\ follower' = None
        /\ UNCHANGED <<slot, live, delivered, handled, window, drops, violation>>

\* The connection ends. A handler that still runs decides later whether its Packet Identifier stays.
Drop == /\ status \in {"active", "stopping"} /\ drops < 2
        /\ status' = "down" /\ drops' = drops + 1
        /\ slot' = "idle" /\ live' = None /\ follower' = None /\ window' = {}
        /\ \/ UNCHANGED <<delivered, handled>>
           \/ /\ slot = "handling"
              /\ delivered' = delivered \ {live}
              /\ handled' = [handled EXCEPT ![live] = @ - 1]
        /\ UNCHANGED violation

\* Session Present true keeps the recorded Packet Identifiers.
Resume == /\ status = "down" /\ status' = "active"
          /\ delivered' = IF Fault = "restart" THEN {} ELSE delivered
          /\ UNCHANGED <<slot, live, follower, handled, window, drops, violation>>

\* Session Present false starts a new session, so every PUBLISH is a new message.
Fresh == /\ status = "down" /\ status' = "active"
         /\ delivered' = {} /\ handled' = [id \in Ids |-> 0]
         /\ UNCHANGED <<slot, live, follower, window, drops, violation>>

Next == Publish \/ HandlerSuccess \/ HandlerFailure \/ Release \/ CompleteSettled \/ Stop \/ Drop \/ Resume \/ Fresh
Spec == Init /\ [][Next]_vars

\* MQTT-4.3.3-10: one exchange delivers to the application at most once, also across a resumed session.
DeliveredOnce == \A id \in Ids : handled[id] <= 1
\* Receive Maximum 1: at most one publication of this connection waits for its PUBCOMP.
BoundedWindow == Cardinality(window) <= 1
SlotHeldUntilRelease == slot = "releasing" => live \in delivered
FailedHandlerForgets == violation # "keep"
NoAnswerAfterStop == violation # "late"
=============================================================================
