----------------------------- MODULE QosTwoInbound -----------------------------
\* Rule: One inbound QoS 2 exchange reaches the handler at most once, also across a resumed session. The outcome of a
\* handler changes only the record of its own delivery, also when it settles after its connection ended. A publication
\* of this connection holds the one receive slot until its PUBREL. A failed handler leaves no record, and a session
\* that stopped keeps the record it had.
\* Source: src/portable.ts (receiveQosOne, deliverQosTwo, receiveRelease, answer, advanceInbound, disconnect)
\* Source: src/inboundQosTwo.ts (begin, delivered, failed, release, phase, clear)
\* Source: src/sessionState.ts (inbound, resume)
\* Tests: test/qos2-inbound.test.ts, test/qos2-resume.test.ts
\* Mapping: Publish is receiveQosOne with its duplicate check, which reads phase. Start is deliverQosTwo calling begin
\* and onQosTwoMessage. HandlerSuccess is delivered and the PUBREC write, and HandlerFailure is failed, both in
\* deliverQosTwo. Release is receiveRelease, which calls release. CompleteSettled is the settled PUBCOMP write in answer,
\* which calls advanceInbound. Stop is disconnect. Drop ends the connection while a handler may still run. LateSuccess
\* and LateFailure are delivered and failed for that handler, at any later time. Resume and Fresh are resume in the
\* session state, and Fresh calls clear. owner is the map from Packet Identifier to the token of a running delivery. It
\* says which handler the token belongs to, because at most two handlers run in the model.
\* Not modeled: The opening and accepted phases, QoS 1 publications in the same slot, the PUBCOMP for an unknown
\* identifier, a session that continues after a protocol error or a failed handler, and more than one handler that
\* outlives its connection.
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLES status, slot, live, follower, owner, waiting, handled, failed, window, drops, orphan, stale, kept
vars == <<status, slot, live, follower, owner, waiting, handled, failed, window, drops, orphan, stale, kept>>

Ids == {1, 2}
None == 0
\* The Packet Identifier names a publication whose exchange has not ended.
Recorded(id) == owner[id] # "none" \/ id \in waiting

\* handled counts the handler calls of the exchange that a Packet Identifier names now. failed holds the identifiers
\* whose last call failed. stale says that the exchange of the orphaned handler has ended. kept is the waiting set
\* when the session stopped. These four record what happened, and the client has no copy of them.
Init == /\ status = "active" /\ slot = "idle" /\ live = None /\ follower = None
        /\ owner = [id \in Ids |-> "none"] /\ waiting = {}
        /\ handled = [id \in Ids |-> 0] /\ failed = {}
        /\ window = {} /\ drops = 0 /\ orphan = None /\ stale = FALSE /\ kept = {}

Retire == /\ status' = "retired" /\ slot' = "idle" /\ live' = None /\ follower' = None
          /\ window' = {}

\* The session records the delivery under its token, then runs the handler.
Start(id) == /\ slot' = "handling" /\ live' = id
             /\ owner' = [owner EXCEPT ![id] = "live"] /\ waiting' = waiting \ {id}
             /\ handled' = [handled EXCEPT ![id] = @ + 1]
             /\ failed' = failed \ {id}
             /\ window' = window \cup {id}

\* A QoS 2 PUBLISH arrives. A recorded Packet Identifier makes it a duplicate, which starts no delivery.
Publish == \E id \in Ids:
  /\ status = "active"
  /\ UNCHANGED <<orphan, stale, kept>>
  /\ IF Recorded(id) /\ Fault # "duplicate"
     THEN UNCHANGED <<status, slot, live, follower, owner, waiting, handled, failed, window, drops>>
     ELSE IF slot = "idle"
     THEN Start(id) /\ UNCHANGED <<status, follower, drops>>
     ELSE IF slot = "acknowledging" /\ follower = None
     THEN follower' = id /\ UNCHANGED <<status, slot, live, owner, waiting, handled, failed, window, drops>>
     ELSE Retire /\ UNCHANGED <<owner, waiting, handled, failed, drops>>

\* The handler fulfilled, so its delivery waits for PUBREL. An active session sends PUBREC and keeps the slot.
HandlerSuccess ==
  /\ slot = "handling"
  /\ IF owner[live] = "live"
     THEN owner' = [owner EXCEPT ![live] = "none"] /\ waiting' = waiting \cup {live}
     ELSE UNCHANGED <<owner, waiting>>
  /\ IF status = "active"
     THEN slot' = (IF Fault = "slot" THEN "idle" ELSE "releasing") /\ UNCHANGED live
     ELSE slot' = "idle" /\ live' = None
  /\ UNCHANGED <<status, follower, handled, failed, window, drops, orphan, stale, kept>>

\* The handler failed. The session ends without PUBREC, and the delivery leaves the record.
HandlerFailure ==
  /\ slot = "handling" /\ status \in {"active", "stopping"}
  /\ owner' = IF owner[live] = "live" /\ Fault # "keep" THEN [owner EXCEPT ![live] = "none"] ELSE owner
  /\ handled' = [handled EXCEPT ![live] = @ - 1]
  /\ failed' = failed \cup {live}
  /\ Retire /\ UNCHANGED <<waiting, drops, orphan, stale, kept>>

\* PUBREL arrives. A recorded Packet Identifier gets PUBCOMP and leaves the record. A stopped session answers nothing.
Release == \E id \in Ids:
  /\ status = "active" \/ (status = "stopping" /\ Fault = "late")
  /\ IF live = id /\ slot = "handling"
     THEN Retire /\ UNCHANGED <<owner, waiting, handled, failed, drops, orphan, stale, kept>>
     ELSE IF ~Recorded(id)
     THEN UNCHANGED vars
     ELSE /\ owner' = [owner EXCEPT ![id] = "none"] /\ waiting' = waiting \ {id}
          /\ handled' = [handled EXCEPT ![id] = 0]
          /\ window' = window \ {id}
          /\ stale' = (stale \/ orphan = id)
          /\ IF live = id
             THEN slot' = "acknowledging" /\ live' = None
             ELSE UNCHANGED <<slot, live>>
          /\ UNCHANGED <<status, follower, failed, drops, orphan, kept>>

\* The PUBCOMP write settled, so the retained next PUBLISH is handled.
CompleteSettled ==
  /\ slot = "acknowledging"
  /\ UNCHANGED <<orphan, stale, kept>>
  /\ IF follower # None /\ status = "active" /\ ~Recorded(follower)
     THEN Start(follower) /\ follower' = None /\ UNCHANGED <<status, drops>>
     ELSE /\ slot' = "idle" /\ follower' = None
          /\ UNCHANGED <<status, live, owner, waiting, handled, failed, window, drops>>

\* disconnect() discards the retained PUBLISH and answers nothing more.
Stop == /\ status = "active" /\ status' = "stopping" /\ follower' = None /\ kept' = waiting
        /\ UNCHANGED <<slot, live, owner, waiting, handled, failed, window, drops, orphan, stale>>

\* The connection ends. A handler that still runs keeps its token and settles later. One such handler at a time bounds
\* the model.
Drop == /\ status \in {"active", "stopping"} /\ drops < 2
        /\ slot = "handling" => orphan = None
        /\ status' = "down" /\ drops' = drops + 1
        /\ slot' = "idle" /\ live' = None /\ follower' = None /\ window' = {}
        /\ IF slot = "handling"
           THEN /\ orphan' = live /\ stale' = FALSE
                /\ owner' = IF owner[live] = "live" THEN [owner EXCEPT ![live] = "orphan"] ELSE owner
           ELSE UNCHANGED <<orphan, stale, owner>>
        /\ UNCHANGED <<waiting, handled, failed, kept>>

\* The handler of an earlier connection fulfilled. Its delivery waits for PUBREL when the record still has its token.
LateSuccess ==
  /\ orphan # None
  /\ IF owner[orphan] = "orphan"
     THEN owner' = [owner EXCEPT ![orphan] = "none"] /\ waiting' = waiting \cup {orphan}
     ELSE UNCHANGED <<owner, waiting>>
  /\ orphan' = None /\ stale' = FALSE
  /\ UNCHANGED <<status, slot, live, follower, handled, failed, window, drops, kept>>

\* The handler of an earlier connection failed. It removes its own delivery. The shared fault removes whatever the
\* Packet Identifier names now, as a record without tokens does.
LateFailure ==
  /\ orphan # None
  /\ IF Fault = "shared"
     THEN owner' = [owner EXCEPT ![orphan] = "none"] /\ waiting' = waiting \ {orphan}
     ELSE /\ owner' = IF owner[orphan] = "orphan" THEN [owner EXCEPT ![orphan] = "none"] ELSE owner
          /\ UNCHANGED waiting
  \* A failure while the exchange still runs takes back its one handler call.
  /\ handled' = IF ~stale /\ handled[orphan] > 0 THEN [handled EXCEPT ![orphan] = @ - 1] ELSE handled
  /\ failed' = IF stale THEN failed ELSE failed \cup {orphan}
  /\ orphan' = None /\ stale' = FALSE
  /\ UNCHANGED <<status, slot, live, follower, window, drops, kept>>

\* Session Present true keeps the record.
Resume == /\ status = "down" /\ status' = "active"
          /\ IF Fault = "restart"
             THEN owner' = [id \in Ids |-> "none"] /\ waiting' = {}
             ELSE UNCHANGED <<owner, waiting>>
          /\ UNCHANGED <<slot, live, follower, handled, failed, window, drops, orphan, stale, kept>>

\* Session Present false starts a new session, so every PUBLISH is a new message.
Fresh == /\ status = "down" /\ status' = "active"
         /\ owner' = [id \in Ids |-> "none"] /\ waiting' = {}
         /\ handled' = [id \in Ids |-> 0] /\ failed' = {}
         /\ stale' = (stale \/ orphan # None)
         /\ UNCHANGED <<slot, live, follower, window, drops, orphan, kept>>

Next == Publish \/ HandlerSuccess \/ HandlerFailure \/ Release \/ CompleteSettled \/ Stop \/ Drop \/ LateSuccess
        \/ LateFailure \/ Resume \/ Fresh
Spec == Init /\ [][Next]_vars

\* MQTT-4.3.3-10: one exchange delivers to the application at most once, also across a resumed session.
DeliveredOnce == \A id \in Ids : handled[id] <= 1
\* Receive Maximum 1 means that at most one publication of this connection waits for its PUBCOMP.
BoundedWindow == Cardinality(window) <= 1
\* The publication in the slot stays recorded until its PUBREL, so that PUBREL frees the slot.
SlotHeldUntilRelease == slot = "releasing" => live \in waiting
\* A failed handler leaves no record, so the next PUBLISH with its Packet Identifier is delivered.
FailedHandlerForgets == \A id \in failed : ~Recorded(id)
\* A PUBREL that the client answers leaves the record, so a stopped session still has every identifier it had.
NoAnswerAfterStop == status = "stopping" => kept \subseteq waiting
=============================================================================
