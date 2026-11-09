-------------------------- MODULE SubscriptionOwnership --------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLES owner, started, held, sent, acked, released, cleaned, cost, identifierOf, retired, terminalStarted, wrong, invalidSeen
vars == <<owner, started, held, sent, acked, released, cleaned, cost, identifierOf, retired, terminalStarted, wrong, invalidSeen>>
Ids == {1, 2, 3}
Leases == {1, 2, 3}
ExpectedKind(lease) == IF lease = 2 THEN "unsuback" ELSE "suback"
Occupied == {identifier \in Ids : owner[identifier] # 0}
Owners == {owner[identifier] : identifier \in Occupied}
Bytes == (IF 1 \in Owners THEN cost[1] ELSE 0)
       + (IF 2 \in Owners THEN cost[2] ELSE 0)
       + (IF 3 \in Owners THEN cost[3] ELSE 0)
Init == /\ owner = [identifier \in Ids |-> 0]
        /\ started = {} /\ held = {} /\ sent = {} /\ acked = {}
        /\ released = {} /\ cleaned = {} /\ cost = [lease \in Leases |-> 1]
        /\ identifierOf = [lease \in Leases |-> 1]
        /\ retired = FALSE /\ terminalStarted = {} /\ wrong = FALSE /\ invalidSeen = FALSE
Reserve == \E lease \in Leases \ started, identifier \in Ids, charge \in {1, 3}:
  /\ (~retired \/ Fault = "retired")
  /\ (owner[identifier] = 0 \/ Fault = "reuse")
  /\ (Cardinality(Occupied) < 2 \/ Fault = "items")
  /\ (Bytes + charge <= 3 \/ Fault = "bytes")
  /\ owner' = [owner EXCEPT ![identifier] = lease]
  /\ started' = started \cup {lease} /\ held' = held \cup {lease}
  /\ cost' = [cost EXCEPT ![lease] = charge]
  /\ identifierOf' = [identifierOf EXCEPT ![lease] = identifier]
  /\ UNCHANGED <<sent, acked, released, cleaned, retired, terminalStarted, wrong, invalidSeen>>
Send == \E lease \in started \ sent:
  /\ sent' = sent \cup {lease}
  /\ UNCHANGED <<owner, started, held, acked, released, cleaned, cost, identifierOf, retired, terminalStarted, wrong, invalidSeen>>
Ack == \E lease \in held \ acked, kind \in {"suback", "unsuback", "other"}:
  /\ ~retired /\ (kind = ExpectedKind(lease) \/ Fault = "kind")
  /\ acked' = acked \cup {lease}
  /\ wrong' = (wrong \/ kind # ExpectedKind(lease))
  /\ UNCHANGED <<owner, started, held, sent, released, cleaned, cost, identifierOf, retired, terminalStarted, invalidSeen>>
Release == \E lease \in held:
  /\ ~retired /\ lease \in acked
  /\ (lease \in sent \/ Fault = "early")
  /\ owner' = [identifier \in Ids |-> IF owner[identifier] = lease THEN 0 ELSE owner[identifier]]
  /\ held' = held \ {lease} /\ released' = released \cup {lease}
  /\ UNCHANGED <<started, sent, acked, cleaned, cost, identifierOf, retired, terminalStarted, wrong, invalidSeen>>
OldCleanup == \E lease \in released \ cleaned:
  /\ cleaned' = cleaned \cup {lease}
  /\ owner' = IF Fault = "stale" THEN [owner EXCEPT ![identifierOf[lease]] = 0] ELSE owner
  /\ UNCHANGED <<started, held, sent, acked, released, cost, identifierOf, retired, terminalStarted, wrong, invalidSeen>>
RetireWith(invalid) == /\ ~retired /\ retired' = TRUE /\ terminalStarted' = started
          /\ invalidSeen' = (invalidSeen \/ invalid)
          /\ owner' = [identifier \in Ids |-> 0]
          /\ UNCHANGED <<started, held, sent, acked, released, cleaned, cost, identifierOf, wrong>>
Retire == RetireWith(FALSE)
BadAck == /\ (held \ acked) # {} /\ ~retired
          /\ IF Fault = "malformed"
              THEN /\ invalidSeen' = TRUE
                   /\ UNCHANGED <<owner, started, held, sent, acked, released, cleaned, cost, identifierOf, retired, terminalStarted, wrong>>
              ELSE RetireWith(TRUE)
Next == Reserve \/ Send \/ Ack \/ BadAck \/ Release \/ OldCleanup \/ Retire
Spec == Init /\ [][Next]_vars
BoundedItems == Cardinality(Occupied) <= 2
BoundedBytes == Bytes <= 3
OwnedUntilComplete == retired \/ held \subseteq Owners
NoEarlyRelease == released \subseteq (sent \cap acked)
NoWrongKind == ~wrong
InvalidMatchingAckRetires == invalidSeen => retired
NoAdmissionAfterRetirement == ~retired \/ started = terminalStarted
=============================================================================
