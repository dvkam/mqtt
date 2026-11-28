---------------------------- MODULE QosTwoOutbound ----------------------------
\* Rule: An outbound QoS 2 exchange keeps its quota slot until PUBCOMP or a refusing PUBREC. The client writes PUBREL
\* only after an accepting PUBREC and never writes the PUBLISH again afterwards, also on a resumed session. A resumed
\* session writes every stored PUBREL whatever the quota is, and the open exchanges still hold back each PUBLISH. The
\* publish promise resolves only on PUBCOMP, and nothing is written once DISCONNECT is due.
\* Source: src/outboundQosOne.ts (startTwoPhase, received, completed, stop, waitForActive, finishActive, resume, drain)
\* Source: src/sessionState.ts (record, received, completed, resume)
\* Source: src/portable.ts (releasePublication, answerPubrec, receiveQosTwoControl, endWrites)
\* Tests: test/qos2-publish.test.ts, test/qos2-resume.test.ts
\* Mapping: Dispatch is the identifier lease, record and the PUBLISH write in startTwoPhase, behind the quota test in
\* drain. Accept is received with a reason below 0x80, which stores the release phase and writes PUBREL. Refuse is
\* received with 0x80 or above. Complete is completed. Stop is stop. Expire is the drain deadline in waitForActive and
\* finishActive. Disconnect is endWrites and the DISCONNECT write. LateAccept is a PUBREC that arrives once DISCONNECT
\* is due. receiveQosTwoControl answers nothing while the session closes, and answerPubrec writes nothing after
\* endWrites. Drop ends the connection. Resume is resume in the session state and in the queue, which starts every
\* stored PUBREL at once, with the Receive Maximum of the new connection. Continue is a stored PUBLISH that drain sends
\* again when the quota has a slot. Fresh is resume after Session Present false. A PUBREC for an exchange that waits in
\* the resend phase has no action, as received ignores it.
\* Not modeled: The settlement of a write apart from the write, the step between a PUBREC and its PUBREL write and so a
\* PUBCOMP that arrives in it, reason codes, the identifier allocator, the order of the resends and QoS 1 exchanges in
\* the same queue.
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLES connection, quota, phase, stored, outcome, accepted, completed, released, sealed, live, carried, drops
vars == <<connection, quota, phase, stored, outcome, accepted, completed, released, sealed, live, carried, drops>>

Jobs == {1, 2}
Quotas == {1, 2}
Active == {job \in Jobs : phase[job] \in {"publish", "release"}}
Open == connection \in {"active", "draining"}

\* released holds the jobs whose PUBREL was written at least once, and sealed its value when DISCONNECT became due.
\* carried holds the exchanges that this connection continued with PUBREL.
Init == /\ connection = "active" /\ quota \in Quotas
        /\ phase = [job \in Jobs |-> "queued"]
        /\ stored = [job \in Jobs |-> "none"]
        /\ outcome = [job \in Jobs |-> "pending"]
        /\ accepted = {} /\ completed = {} /\ released = {} /\ sealed = {} /\ live = {} /\ carried = {}
        /\ drops = 0

\* The queue leases an identifier, stores the publication and writes PUBLISH.
Dispatch == \E job \in Jobs:
  /\ connection = "active" /\ phase[job] = "queued"
  /\ Cardinality(Active) < quota
  /\ phase' = [phase EXCEPT ![job] = "publish"]
  /\ stored' = [stored EXCEPT ![job] = "publish"]
  /\ live' = live \cup {job}
  /\ UNCHANGED <<connection, quota, outcome, accepted, completed, released, sealed, carried, drops>>

\* A PUBREC below 0x80. The session state keeps the release phase and the client writes PUBREL.
Accept == \E job \in Jobs:
  /\ Open /\ phase[job] = "publish"
  /\ phase' = [phase EXCEPT ![job] = IF Fault = "quota" THEN "ended" ELSE "release"]
  /\ stored' = [stored EXCEPT ![job] = IF Fault = "replay" THEN "publish" ELSE "release"]
  /\ accepted' = accepted \cup {job}
  /\ released' = released \cup {job}
  /\ outcome' = [outcome EXCEPT ![job] = IF Fault = "early" /\ @ = "pending" THEN "resolved" ELSE @]
  /\ UNCHANGED <<connection, quota, completed, sealed, live, carried, drops>>

\* A PUBREC of 0x80 or above ends the exchange and frees its slot. No PUBREL follows.
Refuse == \E job \in Jobs:
  /\ Open /\ phase[job] = "publish"
  /\ phase' = [phase EXCEPT ![job] = "ended"]
  /\ stored' = [stored EXCEPT ![job] = "none"]
  /\ outcome' = [outcome EXCEPT ![job] = IF @ = "pending" THEN "refused" ELSE @]
  /\ released' = IF Fault = "refused" THEN released \cup {job} ELSE released
  /\ UNCHANGED <<connection, quota, accepted, completed, sealed, live, carried, drops>>

\* PUBCOMP ends the exchange and settles the publish promise.
Complete == \E job \in Jobs:
  /\ Open /\ phase[job] = "release"
  /\ phase' = [phase EXCEPT ![job] = "ended"]
  /\ stored' = [stored EXCEPT ![job] = "none"]
  /\ completed' = completed \cup {job}
  /\ outcome' = [outcome EXCEPT ![job] = IF @ = "pending" THEN "resolved" ELSE @]
  /\ UNCHANGED <<connection, quota, accepted, released, sealed, live, carried, drops>>

\* disconnect() rejects the queued publications, drops the resends that have not started and waits for the active exchanges.
Stop == /\ connection = "active" /\ connection' = "draining"
        /\ phase' = [job \in Jobs |-> IF phase[job] \in {"queued", "resend"} THEN "ended" ELSE phase[job]]
        /\ outcome' = [job \in Jobs |-> IF phase[job] = "queued" THEN "rejected" ELSE outcome[job]]
        /\ UNCHANGED <<quota, stored, accepted, completed, released, sealed, live, carried, drops>>

\* The drain deadline rejects each exchange without PUBCOMP. The session state keeps it.
Expire == /\ connection = "draining" /\ Active # {}
          /\ connection' = "disconnecting"
          /\ phase' = [job \in Jobs |-> IF job \in Active THEN "ended" ELSE phase[job]]
          /\ outcome' = [job \in Jobs |->
               IF job \in Active /\ outcome[job] = "pending"
               THEN (IF Fault = "outcome" /\ phase[job] = "release" THEN "resolved" ELSE "rejected")
               ELSE outcome[job]]
          /\ sealed' = released
          /\ UNCHANGED <<quota, stored, accepted, completed, released, live, carried, drops>>

Disconnect == /\ connection = "draining" /\ Active = {}
              /\ connection' = "disconnecting" /\ sealed' = released
              /\ UNCHANGED <<quota, phase, stored, outcome, accepted, completed, released, live, carried, drops>>

\* A PUBREC that arrives once DISCONNECT is due gets no PUBREL, and the stored exchange keeps its phase.
LateAccept == \E job \in Jobs:
  /\ connection = "disconnecting" /\ stored[job] = "publish"
  /\ released' = IF Fault = "late" THEN released \cup {job} ELSE released
  /\ UNCHANGED <<connection, quota, phase, stored, outcome, accepted, completed, sealed, live, carried, drops>>

\* The connection ends. Every unsettled publish promise rejects, and the session state keeps its phases.
Drop == /\ connection # "down" /\ drops < 2
        /\ connection' = "down" /\ drops' = drops + 1 /\ live' = {} /\ carried' = {}
        /\ phase' = [job \in Jobs |-> "ended"]
        /\ outcome' = [job \in Jobs |-> IF outcome[job] = "pending" THEN "rejected" ELSE outcome[job]]
        /\ UNCHANGED <<quota, stored, accepted, completed, released, sealed>>

\* Session Present true, with the Receive Maximum of the new connection. Every stored PUBREL goes out at once, because
\* the quota holds back only PUBLISH packets (MQTT 5 section 4.9). Each stored PUBLISH waits for a quota slot.
Resume == \E next \in Quotas:
  LET starts == {job \in Jobs : stored[job] = "release" /\ Fault # "held"} IN
  /\ connection = "down"
  /\ connection' = "active" /\ quota' = next
  /\ phase' = [job \in Jobs |->
       IF stored[job] = "none" THEN "ended" ELSE IF job \in starts THEN "release" ELSE "resend"]
  /\ live' = starts /\ carried' = starts
  /\ UNCHANGED <<stored, outcome, accepted, completed, released, sealed, drops>>

\* A quota slot is free, so a stored exchange continues with the packet of its stored phase.
Continue == \E job \in Jobs:
  /\ connection = "active" /\ phase[job] = "resend"
  /\ Cardinality(Active) < quota
  /\ phase' = [phase EXCEPT ![job] = stored[job]]
  /\ live' = live \cup {job}
  /\ UNCHANGED <<connection, quota, stored, outcome, accepted, completed, released, sealed, carried, drops>>

\* Session Present false drops the stored exchanges.
Fresh == \E next \in Quotas:
  /\ connection = "down"
  /\ connection' = "active" /\ quota' = next
  /\ stored' = [job \in Jobs |-> "none"]
  /\ UNCHANGED <<phase, outcome, accepted, completed, released, sealed, live, carried, drops>>

Next == Dispatch \/ Accept \/ Refuse \/ Complete \/ Stop \/ Expire \/ Disconnect \/ LateAccept \/ Drop \/ Resume
        \/ Continue \/ Fresh
Spec == Init /\ [][Next]_vars

\* An exchange keeps its quota slot until PUBCOMP or a refusing PUBREC.
HeldUntilComplete == \A job \in live : (stored[job] = "release" /\ Open) => phase[job] = "release"
\* MQTT-3.3.4-8 and section 4.9: a stored PUBREL never waits for a quota slot.
ReleaseNotDelayed == \A job \in Jobs : phase[job] = "resend" => stored[job] = "publish"
\* An exchange that a PUBLISH of this connection started is open only while all open exchanges fit the quota. The
\* exchanges that the connection continued with PUBREL may exceed it alone.
BoundedQuota == Active \subseteq carried \/ Cardinality(Active) <= quota
\* MQTT-4.3.3-4: only an accepting PUBREC leads to a PUBREL.
ReleaseAfterAccept == released \subseteq accepted
\* MQTT-4.3.3-6: no PUBLISH once the PUBREL was sent, on this connection or a resumed one.
NoPublishAfterRelease == \A job \in Jobs : phase[job] = "publish" => job \notin released
ResolveOnComplete == \A job \in Jobs : outcome[job] = "resolved" => job \in completed
\* MQTT-3.14.4-1: no PUBREL once DISCONNECT is due.
NoReleaseAfterDisconnect == connection = "disconnecting" => released = sealed
StoredPhaseFollowsPubrec == \A job \in Jobs : stored[job] = "release" => job \in accepted
=============================================================================
