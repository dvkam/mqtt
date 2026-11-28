---------------------------- MODULE QosTwoOutbound ----------------------------
\* Rule: An outbound QoS 2 exchange keeps its quota slot until PUBCOMP or a refusing PUBREC. The client writes PUBREL
\* only after an accepting PUBREC and never writes the PUBLISH again afterwards, also on a resumed session. The publish
\* promise resolves only on PUBCOMP, and nothing is written once DISCONNECT is due.
\* Source: src/outboundPublications.ts (startTwoPhase, received, completed, stop, waitForActive, finishActive, resume)
\* Source: src/sessionState.ts (record, received, completed, resume)
\* Source: src/portable.ts (releasePublication, endWrites)
\* Tests: test/qos2-publish.test.ts, test/qos2-resume.test.ts
\* Mapping: Dispatch is the identifier lease, record and the PUBLISH write in startTwoPhase. Accept is received with a
\* reason below 0x80, which stores the release phase and writes PUBREL. Refuse is received with 0x80 or above. Complete is
\* completed. Stop is stop. Expire is the drain deadline in waitForActive and finishActive. Disconnect is endWrites and
\* the DISCONNECT write. LateAccept is a PUBREC in releasePublication after endWrites. Drop ends the connection.
\* Resume and Continue are resume in the session state and the queue. Fresh is resume after Session Present false.
\* Not modeled: The settlement of a write apart from the write, reason codes, the identifier allocator, the order of
\* the resends and QoS 1 exchanges in the same queue.
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLES connection, phase, stored, outcome, accepted, completed, released, live, drops, violation
vars == <<connection, phase, stored, outcome, accepted, completed, released, live, drops, violation>>

Jobs == {1, 2}
Quota == 1
Active == {job \in Jobs : phase[job] \in {"publish", "release"}}
Open == connection \in {"active", "draining"}

Init == /\ connection = "active"
        /\ phase = [job \in Jobs |-> "queued"]
        /\ stored = [job \in Jobs |-> "none"]
        /\ outcome = [job \in Jobs |-> "pending"]
        /\ accepted = {} /\ completed = {} /\ released = {} /\ live = {}
        /\ drops = 0 /\ violation = "none"

\* The queue leases an identifier, stores the publication and writes PUBLISH.
Dispatch == \E job \in Jobs:
  /\ connection = "active" /\ phase[job] = "queued"
  /\ Cardinality(Active) < Quota
  /\ phase' = [phase EXCEPT ![job] = "publish"]
  /\ stored' = [stored EXCEPT ![job] = "publish"]
  /\ live' = live \cup {job}
  /\ UNCHANGED <<connection, outcome, accepted, completed, released, drops, violation>>

\* A PUBREC below 0x80. The session state keeps the release phase and the client writes PUBREL.
Accept == \E job \in Jobs:
  /\ Open /\ phase[job] = "publish"
  /\ phase' = [phase EXCEPT ![job] = IF Fault = "quota" THEN "ended" ELSE "release"]
  /\ stored' = [stored EXCEPT ![job] = IF Fault = "replay" THEN "publish" ELSE "release"]
  /\ accepted' = accepted \cup {job}
  /\ released' = released \cup {job}
  /\ outcome' = [outcome EXCEPT ![job] = IF Fault = "early" /\ @ = "pending" THEN "resolved" ELSE @]
  /\ UNCHANGED <<connection, completed, live, drops, violation>>

\* A PUBREC of 0x80 or above ends the exchange and frees its slot. No PUBREL follows.
Refuse == \E job \in Jobs:
  /\ Open /\ phase[job] = "publish"
  /\ phase' = [phase EXCEPT ![job] = "ended"]
  /\ stored' = [stored EXCEPT ![job] = "none"]
  /\ outcome' = [outcome EXCEPT ![job] = IF @ = "pending" THEN "refused" ELSE @]
  /\ released' = IF Fault = "refused" THEN released \cup {job} ELSE released
  /\ violation' = IF Fault = "refused" THEN "release" ELSE violation
  /\ UNCHANGED <<connection, accepted, completed, live, drops>>

\* PUBCOMP ends the exchange and settles the publish promise.
Complete == \E job \in Jobs:
  /\ Open /\ phase[job] = "release"
  /\ phase' = [phase EXCEPT ![job] = "ended"]
  /\ stored' = [stored EXCEPT ![job] = "none"]
  /\ completed' = completed \cup {job}
  /\ outcome' = [outcome EXCEPT ![job] = IF @ = "pending" THEN "resolved" ELSE @]
  /\ UNCHANGED <<connection, accepted, released, live, drops, violation>>

\* disconnect() rejects the queued publications, drops the resends that have not started and waits for the active exchanges.
Stop == /\ connection = "active" /\ connection' = "draining"
        /\ phase' = [job \in Jobs |-> IF phase[job] \in {"queued", "resend"} THEN "ended" ELSE phase[job]]
        /\ outcome' = [job \in Jobs |-> IF phase[job] = "queued" THEN "rejected" ELSE outcome[job]]
        /\ UNCHANGED <<stored, accepted, completed, released, live, drops, violation>>

\* The drain deadline rejects each exchange without PUBCOMP. The session state keeps it.
Expire == /\ connection = "draining" /\ Active # {}
          /\ connection' = "disconnecting"
          /\ phase' = [job \in Jobs |-> IF job \in Active THEN "ended" ELSE phase[job]]
          /\ outcome' = [job \in Jobs |->
               IF job \in Active /\ outcome[job] = "pending"
               THEN (IF Fault = "outcome" /\ phase[job] = "release" THEN "resolved" ELSE "rejected")
               ELSE outcome[job]]
          /\ UNCHANGED <<stored, accepted, completed, released, live, drops, violation>>

Disconnect == /\ connection = "draining" /\ Active = {}
              /\ connection' = "disconnecting"
              /\ UNCHANGED <<phase, stored, outcome, accepted, completed, released, live, drops, violation>>

\* A PUBREC that arrives once DISCONNECT is due gets no PUBREL.
LateAccept == \E job \in Jobs:
  /\ connection = "disconnecting" /\ stored[job] = "publish" /\ Fault = "late"
  /\ violation' = "late"
  /\ UNCHANGED <<connection, phase, stored, outcome, accepted, completed, released, live, drops>>

\* The connection ends. Every unsettled publish promise rejects, and the session state keeps its phases.
Drop == /\ connection # "down" /\ drops < 2
        /\ connection' = "down" /\ drops' = drops + 1 /\ live' = {}
        /\ phase' = [job \in Jobs |-> "ended"]
        /\ outcome' = [job \in Jobs |-> IF outcome[job] = "pending" THEN "rejected" ELSE outcome[job]]
        /\ UNCHANGED <<stored, accepted, completed, released, violation>>

\* Session Present true. Each stored exchange waits for a quota slot.
Resume == /\ connection = "down"
          /\ connection' = "active"
          /\ phase' = [job \in Jobs |-> IF stored[job] = "none" THEN "ended" ELSE "resend"]
          /\ UNCHANGED <<stored, outcome, accepted, completed, released, live, drops, violation>>

\* PUBREL continues a released exchange, and PUBLISH with DUP any other.
Continue == \E job \in Jobs:
  /\ connection = "active" /\ phase[job] = "resend"
  /\ Cardinality(Active) < Quota
  /\ phase' = [phase EXCEPT ![job] = stored[job]]
  /\ live' = live \cup {job}
  /\ violation' = IF stored[job] = "publish" /\ job \in released THEN "replay" ELSE violation
  /\ UNCHANGED <<connection, stored, outcome, accepted, completed, released, drops>>

\* Session Present false drops the stored exchanges.
Fresh == /\ connection = "down"
         /\ connection' = "active"
         /\ stored' = [job \in Jobs |-> "none"]
         /\ UNCHANGED <<phase, outcome, accepted, completed, released, live, drops, violation>>

Next == Dispatch \/ Accept \/ Refuse \/ Complete \/ Stop \/ Expire \/ Disconnect \/ LateAccept \/ Drop \/ Resume
        \/ Continue \/ Fresh
Spec == Init /\ [][Next]_vars

\* An exchange keeps its quota slot until PUBCOMP or a refusing PUBREC.
HeldUntilComplete == \A job \in live : (stored[job] = "release" /\ Open) => phase[job] = "release"
BoundedQuota == Cardinality(Active) <= Quota
ReleaseAfterAccept == violation # "release"
\* MQTT-4.3.3-6: no PUBLISH once the PUBREL was sent, on this connection or a resumed one.
NoPublishAfterRelease == violation # "replay"
ResolveOnComplete == \A job \in Jobs : outcome[job] = "resolved" => job \in completed
NoReleaseAfterDisconnect == violation # "late"
StoredPhaseFollowsPubrec == \A job \in Jobs : stored[job] = "release" => job \in accepted
=============================================================================
