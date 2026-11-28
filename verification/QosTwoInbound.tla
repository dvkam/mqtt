----------------------------- MODULE QosTwoInbound -----------------------------
\* Rule: One inbound QoS 2 exchange reaches the handler at most once at a time, also across a resumed session. The
\* client sends PUBREC or PUBCOMP only for a publication whose handler fulfilled. The outcome of a handler changes
\* only the record of its own delivery, also when it settles after its connection ended. A publication of this
\* connection holds the one receive slot until its PUBREL, and so does a duplicate that waits for the handler of an
\* earlier connection. A failed handler leaves no record, and a session that stopped keeps the record it had. A
\* PUBLISH without DUP for an identifier that an earlier connection recorded is a new message and reaches the handler.
\* Source: src/portable.ts (receiveQosOne, deliverQosTwo, receiveRelease, answer, advanceInbound, disconnect)
\* Source: src/inboundQosTwo.ts (begin, delivered, failed, release, phase, outcome, clear)
\* Source: src/sessionState.ts (inbound, resume)
\* Tests: test/qos2-inbound.test.ts, test/qos2-resume.test.ts, test/qos2-held-duplicate.test.ts
\* Tests: test/qos2-inbound-fuzz.test.ts
\* Mapping: Publish is receiveQosOne with its duplicate check, which reads phase. Start is deliverQosTwo calling begin
\* and onQosTwoMessage. Hold is deliverQosTwo waiting for outcome, with the publication in the slot. HandlerSuccess is
\* delivered and the PUBREC write, and HandlerFailure is failed, both in deliverQosTwo. Release is receiveRelease,
\* which calls release. CompleteSettled is the settled PUBCOMP write in answer, which calls advanceInbound. Stop is
\* disconnect. Drop ends the connection while a handler may still run. LateSuccess and LateFailure are delivered and
\* failed for that handler, at any later time, and the outcome they report to the connection that waits. Resume and
\* Fresh are resume in the session state, and Fresh calls clear. owner is the map from Packet Identifier to the token
\* of a running delivery. It says which handler the token belongs to, because at most two handlers run in the model.
\* acked holds the identifiers whose exchange got a PUBREC, or a PUBCOMP with reason 0 without one. Replaced is a
\* Session Present true for a broker session that replaced the recorded one, which the client cannot tell from Resume.
\* old holds the identifiers that the client still has recorded from the replaced session. The broker's first PUBLISH
\* with such an identifier has DUP 0, which is how receiveQosOne tells it from a PUBLISH that is sent again.
\* Not modeled: The opening and accepted phases, QoS 1 publications in the same slot, the PUBCOMP for an unknown
\* identifier, a session that continues after a protocol error or a failed handler, more than one handler that
\* outlives its connection, the operation deadline of a handler and of a wait, the microtask turns between a failed
\* handler of an earlier connection and the handler call that follows it, and a broker that sends a PUBLISH again
\* without the DUP flag against MQTT-3.3.1-1.
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLES status, slot, live, follower, owner, waiting, handled, failed, window, drops, orphan, stale, kept, acked, old
vars == <<status, slot, live, follower, owner, waiting, handled, failed, window, drops, orphan, stale, kept, acked, old>>

Ids == {1, 2}
None == 0
\* The Packet Identifier names a publication whose exchange has not ended.
Recorded(id) == owner[id] # "none" \/ id \in waiting

\* handled counts the handler calls of the exchange that a Packet Identifier names now. failed holds the identifiers
\* whose last call failed. stale says that the exchange of the orphaned handler has ended. kept is the waiting set
\* when the session stopped. acked and old are described in the header. These six record what happened, and the
\* client has no copy of them.
Init == /\ status = "active" /\ slot = "idle" /\ live = None /\ follower = None
        /\ owner = [id \in Ids |-> "none"] /\ waiting = {}
        /\ handled = [id \in Ids |-> 0] /\ failed = {}
        /\ window = {} /\ drops = 0 /\ orphan = None /\ stale = FALSE /\ kept = {} /\ acked = {} /\ old = {}

Retire == /\ status' = "retired" /\ slot' = "idle" /\ live' = None /\ follower' = None
          /\ window' = {}

\* The session records the delivery under its token, then runs the handler.
Start(id) == /\ slot' = "handling" /\ live' = id
             /\ owner' = [owner EXCEPT ![id] = "live"] /\ waiting' = waiting \ {id}
             /\ handled' = [handled EXCEPT ![id] = @ + 1]
             /\ failed' = failed \ {id}
             /\ window' = window \cup {id}

\* The duplicate of a publication whose handler an earlier connection started takes the slot and waits for it.
Hold(id) == /\ slot' = "holding" /\ live' = id /\ window' = window \cup {id}
            /\ UNCHANGED <<owner, waiting, handled, failed>>

\* A QoS 2 PUBLISH arrives. A recorded Packet Identifier makes it a duplicate, which starts no delivery. It gets PUBREC
\* again once the handler fulfilled. While the handler runs on this connection, or this connection waits for it, the
\* PUBREC that follows answers it. The immediate fault answers the duplicate of an earlier connection's handler at
\* once, as the client did before it held that PUBREC.
\* An identifier in old arrives without DUP, so its PUBLISH is a new message and not a duplicate. The stale fault
\* takes it for the duplicate that its identifier suggests, as the client did before it read the DUP flag.
Publish == \E id \in Ids:
  LET duplicate == Fault # "duplicate" /\ (id \notin old \/ Fault = "stale") IN
  /\ status = "active"
  /\ UNCHANGED <<orphan, stale, kept>>
  /\ IF id \in waiting /\ duplicate
     THEN acked' = acked \cup {id}
          /\ UNCHANGED <<status, slot, live, follower, owner, waiting, handled, failed, window, drops, old>>
     ELSE IF duplicate /\ (owner[id] = "live" \/ (owner[id] = "orphan" /\ live = id))
     THEN UNCHANGED <<status, slot, live, follower, owner, waiting, handled, failed, window, drops, acked, old>>
     ELSE IF Fault = "immediate" /\ owner[id] = "orphan" /\ duplicate
     THEN acked' = acked \cup {id}
          /\ UNCHANGED <<status, slot, live, follower, owner, waiting, handled, failed, window, drops, old>>
     ELSE IF slot = "idle"
     THEN /\ IF owner[id] = "orphan" /\ duplicate THEN Hold(id) /\ UNCHANGED old ELSE Start(id) /\ old' = old \ {id}
          /\ UNCHANGED <<status, follower, drops, acked>>
     ELSE IF slot = "acknowledging" /\ follower = None
     THEN follower' = id
          /\ UNCHANGED <<status, slot, live, owner, waiting, handled, failed, window, drops, acked, old>>
     ELSE Retire /\ UNCHANGED <<owner, waiting, handled, failed, drops, acked, old>>

\* The handler fulfilled, so its delivery waits for PUBREL. An active session sends PUBREC and keeps the slot.
HandlerSuccess ==
  /\ slot = "handling"
  /\ IF owner[live] = "live"
     THEN owner' = [owner EXCEPT ![live] = "none"] /\ waiting' = waiting \cup {live}
     ELSE UNCHANGED <<owner, waiting>>
  /\ IF status = "active"
     THEN slot' = (IF Fault = "slot" THEN "idle" ELSE "releasing") /\ acked' = acked \cup {live} /\ UNCHANGED live
     ELSE slot' = "idle" /\ live' = None /\ UNCHANGED acked
  /\ UNCHANGED <<status, follower, handled, failed, window, drops, orphan, stale, kept, old>>

\* The handler failed. The session ends without PUBREC, and the delivery leaves the record.
HandlerFailure ==
  /\ slot = "handling" /\ status \in {"active", "stopping"}
  /\ owner' = IF owner[live] = "live" /\ Fault # "keep" THEN [owner EXCEPT ![live] = "none"] ELSE owner
  /\ handled' = [handled EXCEPT ![live] = @ - 1]
  /\ failed' = failed \cup {live}
  /\ Retire /\ UNCHANGED <<waiting, drops, orphan, stale, kept, acked, old>>

\* PUBREL arrives. A publication that waits for it gets PUBCOMP and leaves the record. While a handler still runs
\* for the Packet Identifier, on this connection or since an earlier one, no PUBREC was sent, so the PUBREL is a
\* protocol error. The release fault answers it for the handler of an earlier connection, as the client did before.
\* A stopped session answers nothing.
Release == \E id \in Ids:
  /\ status = "active" \/ (status = "stopping" /\ Fault = "late")
  /\ IF owner[id] = "live" \/ (owner[id] = "orphan" /\ Fault # "release")
     THEN Retire /\ UNCHANGED <<owner, waiting, handled, failed, drops, orphan, stale, kept, acked, old>>
     ELSE IF ~Recorded(id)
     THEN UNCHANGED vars
     ELSE /\ owner' = [owner EXCEPT ![id] = "none"] /\ waiting' = waiting \ {id}
          /\ handled' = [handled EXCEPT ![id] = 0]
          /\ window' = window \ {id}
          /\ stale' = (stale \/ orphan = id)
          /\ acked' = IF id \in waiting THEN acked \ {id} ELSE acked \cup {id}
          /\ old' = old \ {id}
          /\ IF live = id
             THEN slot' = "acknowledging" /\ live' = None
             ELSE UNCHANGED <<slot, live>>
          /\ UNCHANGED <<status, follower, failed, drops, orphan, kept>>

\* The PUBCOMP write settled, so the retained next PUBLISH goes through the duplicate check and the slot.
CompleteSettled ==
  /\ slot = "acknowledging"
  /\ follower' = None
  /\ UNCHANGED <<status, drops, orphan, stale, kept>>
  /\ LET duplicate == follower \notin old \/ Fault = "stale" IN
     IF follower = None \/ status # "active"
     THEN slot' = "idle" /\ UNCHANGED <<live, owner, waiting, handled, failed, window, acked, old>>
     ELSE IF follower \in waiting /\ duplicate
     THEN slot' = "idle" /\ acked' = acked \cup {follower}
          /\ UNCHANGED <<live, owner, waiting, handled, failed, window, old>>
     ELSE IF owner[follower] = "orphan" /\ Fault = "immediate" /\ duplicate
     THEN slot' = "idle" /\ acked' = acked \cup {follower}
          /\ UNCHANGED <<live, owner, waiting, handled, failed, window, old>>
     ELSE IF owner[follower] = "orphan" /\ duplicate
     THEN Hold(follower) /\ UNCHANGED <<acked, old>>
     ELSE Start(follower) /\ old' = old \ {follower} /\ UNCHANGED acked

\* disconnect() discards the retained PUBLISH and answers nothing more.
Stop == /\ status = "active" /\ status' = "stopping" /\ follower' = None /\ kept' = waiting
        /\ UNCHANGED <<slot, live, owner, waiting, handled, failed, window, drops, orphan, stale, acked, old>>

\* The connection ends. A handler that still runs keeps its token and settles later. One such handler at a time bounds
\* the model. A connection that waited for that handler leaves it running.
Drop == /\ status \in {"active", "stopping"} /\ drops < 2
        /\ slot = "handling" => orphan = None
        /\ status' = "down" /\ drops' = drops + 1
        /\ slot' = "idle" /\ live' = None /\ follower' = None /\ window' = {}
        /\ IF slot = "handling"
           THEN /\ orphan' = live /\ stale' = FALSE
                /\ owner' = IF owner[live] = "live" THEN [owner EXCEPT ![live] = "orphan"] ELSE owner
           ELSE UNCHANGED <<orphan, stale, owner>>
        /\ UNCHANGED <<waiting, handled, failed, kept, acked, old>>

\* A connection waits for the handler of an earlier connection, and the silent fault does not tell it the outcome.
Waits == slot = "holding" /\ live = orphan /\ Fault # "silent"

\* The handler of an earlier connection fulfilled. Its delivery waits for PUBREL when the record still has its token.
\* An active connection that waited for it sends PUBREC and keeps the slot.
LateSuccess ==
  /\ orphan # None
  /\ IF owner[orphan] = "orphan"
     THEN owner' = [owner EXCEPT ![orphan] = "none"] /\ waiting' = waiting \cup {orphan}
     ELSE UNCHANGED <<owner, waiting>>
  /\ IF Waits /\ status = "active"
     THEN slot' = "releasing" /\ acked' = acked \cup {orphan} /\ UNCHANGED live
     ELSE IF Waits
     THEN slot' = "idle" /\ live' = None /\ UNCHANGED acked
     ELSE UNCHANGED <<slot, live, acked>>
  /\ orphan' = None /\ stale' = FALSE
  /\ UNCHANGED <<status, follower, handled, failed, window, drops, kept, old>>

\* The handler of an earlier connection failed. It removes its own delivery. An active connection that waited for it
\* calls the handler again, and a stopped one leaves the publication to the next resumed session. The shared fault
\* removes whatever the Packet Identifier names now, as a record without tokens does.
LateFailure ==
  /\ orphan # None
  /\ orphan' = None /\ stale' = FALSE
  /\ UNCHANGED <<status, follower, window, drops, kept, acked, old>>
  /\ IF Waits /\ status = "active"
     THEN /\ slot' = "handling" /\ UNCHANGED live
          /\ owner' = [owner EXCEPT ![orphan] = "live"]
          \* The failure takes back one handler call, and the new call adds one.
          /\ failed' = failed \ {orphan} /\ UNCHANGED <<waiting, handled>>
     ELSE /\ IF Waits THEN slot' = "idle" /\ live' = None ELSE UNCHANGED <<slot, live>>
          /\ IF Fault = "shared"
             THEN owner' = [owner EXCEPT ![orphan] = "none"] /\ waiting' = waiting \ {orphan}
             ELSE /\ owner' = IF owner[orphan] = "orphan" THEN [owner EXCEPT ![orphan] = "none"] ELSE owner
                  /\ UNCHANGED waiting
          \* A failure while the exchange still runs takes back its one handler call.
          /\ handled' = IF ~stale /\ handled[orphan] > 0 THEN [handled EXCEPT ![orphan] = @ - 1] ELSE handled
          /\ failed' = IF stale THEN failed ELSE failed \cup {orphan}

\* Session Present true keeps the record.
Resume == /\ status = "down" /\ status' = "active"
          /\ IF Fault = "restart"
             THEN owner' = [id \in Ids |-> "none"] /\ waiting' = {}
             ELSE UNCHANGED <<owner, waiting>>
          /\ UNCHANGED <<slot, live, follower, handled, failed, window, drops, orphan, stale, kept, acked, old>>

\* Session Present false starts a new session, so every PUBLISH is a new message.
Fresh == /\ status = "down" /\ status' = "active"
         /\ owner' = [id \in Ids |-> "none"] /\ waiting' = {}
         /\ handled' = [id \in Ids |-> 0] /\ failed' = {} /\ acked' = {} /\ old' = {}
         /\ stale' = (stale \/ orphan # None)
         /\ UNCHANGED <<slot, live, follower, window, drops, orphan, kept>>

\* The broker lost the session, and the client never read the CONNACK that said so. The next CONNACK says Session
\* Present true for the session that replaced it, so the client keeps its record, and every exchange it names is gone.
Replaced == /\ status = "down" /\ status' = "active"
            /\ old' = {id \in Ids : Recorded(id)}
            /\ handled' = [id \in Ids |-> 0] /\ failed' = {} /\ acked' = {}
            /\ stale' = (stale \/ orphan # None)
            /\ UNCHANGED <<slot, live, follower, owner, waiting, window, drops, orphan, kept>>

Next == Publish \/ HandlerSuccess \/ HandlerFailure \/ Release \/ CompleteSettled \/ Stop \/ Drop \/ LateSuccess
        \/ LateFailure \/ Resume \/ Fresh \/ Replaced
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
\* An acknowledged delivery has a fulfilled handler, so a handler that fails can still get the message again.
AcknowledgedIsFulfilled == acked \subseteq waiting
\* A new message gets its PUBREC only after a handler call for it, also when its identifier was recorded before.
AcknowledgedIsDelivered == \A id \in acked : handled[id] > 0
\* A connection waits only for a handler that still runs, so every wait ends with that handler.
HeldWaitsForHandler == slot = "holding" => (orphan = live /\ owner[live] = "orphan")
=============================================================================
